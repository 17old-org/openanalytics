import {
  loadSessionConfig,
  sessionize,
  type CanonicalSession,
  type SessionizerEvent,
} from '@openanalytics/domain'
import type {
  SessionFactRow,
  SessionFactsStore,
  StoredSessionFact,
} from '@openanalytics/clickhouse'
import { createRecordingMetrics } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it } from 'vitest'
import type { FinalizerDeps } from '../../apps/worker/src/sessions/deps.ts'
import type { FinalizerState } from '../../apps/worker/src/sessions/state.ts'
import { finalizeSite } from '../../apps/worker/src/sessions/finalizer.ts'

/**
 * The session finalizer's recompute-window row cap.
 *
 * ## What this suite is defending against
 *
 * `readWindowEvents` read `[watermark, infinity)` with no upper bound and no row
 * limit. That is harmless while the watermark advances, and lethal the moment it
 * stops: every event that arrives after the stall joins the same window, the
 * window is read into memory in one go, the process dies, the watermark
 * therefore does not move, and the next run reads strictly more than the last.
 * On 2026-08-22 the worker spent ten hours and 111 restarts in that loop against
 * a site with 961,858 rows in its window, and no alert said so.
 *
 * Capping the read is the easy half. The hard half is that a capped read is a
 * PARTIAL VIEW, and two things in the finalizer treat what they were given as
 * complete:
 *
 *   1. **Retraction.** Every stored session absent from the recomputed set gets
 *      a tombstone. Read a short window of events against a long window of
 *      stored facts and the difference is deleted — silently, and past the point
 *      of recovery.
 *   2. **The watermark.** `planSessionFacts` finalizes everything behind its
 *      horizon. Given the real clock after a short read, it moves the watermark
 *      past rows this run never loaded, and nothing will ever sessionize them.
 *
 * Both are asserted below on a run that is deliberately cut short. Neither is
 * observable in production before it has already happened.
 */

const SITE = '11111111-1111-1111-1111-111111111111'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 6, 28, 12, 0, 0)

/**
 * The store's row cap, shrunk to something a unit test can enumerate.
 *
 * The production constant is 200,000; what is under test is the finalizer's
 * REACTION to a truncated page, which is identical at four rows and at two
 * hundred thousand. The fake honours the same contract the real store does —
 * `truncated` is derived from the raw row count, and only when a `limit` was
 * asked for.
 */
const FAKE_CAP = 4

/** Six single-event sessions, one an hour, all far enough back to be settled. */
const EVENT_TIMES = [
  NOW - 72 * HOUR,
  NOW - 71 * HOUR,
  NOW - 70 * HOUR,
  NOW - 69 * HOUR,
  NOW - 68 * HOUR,
  NOW - 67 * HOUR,
]

/** Where the truncated first read stops: the 4th row is the last one it sees. */
const BOUNDARY_MS = EVENT_TIMES[FAKE_CAP - 1]!

const WATERMARK_START = NOW - 73 * HOUR

function eventAt(occurredMs: number, index: number): SessionizerEvent {
  return {
    eventId: `e${index}`,
    type: 'page_view',
    occurredAt: occurredMs,
    // A distinct visitor per event, so each event is its own session and the
    // arithmetic below is not also a test of the sessionizer's split rules.
    anonymousId: `anon${index}`,
    sessionHint: `hint${index}`,
    pagePath: '/',
  }
}

const ALL_EVENTS = EVENT_TIMES.map((ms, index) => eventAt(ms, index))

/**
 * A stored fact as an earlier run would have written it — derived from the real
 * sessionizer rather than invented.
 *
 * That matters for what the multi-run case can assert. Hand-written ids would
 * never match a recompute, so every later run would tombstone them and the
 * suite could not tell a genuine retraction from an artefact of its own fake.
 */
function storedFactOf(session: CanonicalSession): StoredSessionFact {
  return {
    sessionId: session.sessionId,
    version: 1,
    startMs: session.startMs,
    endMs: session.endMs,
    visitorId: session.visitorId,
    userId: session.userId,
    anonymousId: session.anonymousId,
    sessionHint: session.sessionHint,
    sessionHints: session.sessionHints,
    midnightBridged: session.midnightBridged ? 1 : 0,
    pageviews: session.pageviews,
    engaged: session.engaged ? 1 : 0,
    activeDurationMs: session.activeDurationMs,
    sessionDurationMs: session.sessionDurationMs,
    entryPagePath: session.entryPagePath,
    exitPagePath: session.exitPagePath,
    referrerDomain: session.referrerDomain,
    utmSource: session.utmSource,
    utmMedium: session.utmMedium,
    utmCampaign: session.utmCampaign,
    utmContent: session.utmContent,
    utmTerm: session.utmTerm,
    deviceType: session.deviceType,
    browser: session.browser,
    os: session.os,
    country: session.country,
    city: session.city,
    finalized: 1,
    retracted: 0,
  }
}

/**
 * Facts for the two events beyond the truncation boundary, and only those.
 *
 * This is the bait. If a run reads its stored facts over a wider range than it
 * read its events, these come back, match nothing in the recomputed set, and are
 * tombstoned — which is the data loss itself, not a proxy for it.
 */
const STORED_FACTS = sessionize(SITE, [ALL_EVENTS[4]!, ALL_EVENTS[5]!], loadSessionConfig()).map(
  storedFactOf,
)

interface Harness {
  readonly deps: FinalizerDeps
  readonly windowReads: { fromMs: number; toMs: number; limit?: number }[]
  readonly storedReads: { fromMs: number; toMs: number }[]
  readonly written: SessionFactRow[]
  readonly watermark: () => number
}

function harness(): Harness {
  const windowReads: { fromMs: number; toMs: number; limit?: number }[] = []
  const storedReads: { fromMs: number; toMs: number }[] = []
  const written: SessionFactRow[] = []
  let watermark = WATERMARK_START

  const store = {
    readWindowEvents: async ({
      fromMs,
      toMs,
      limit,
    }: {
      siteId: string
      fromMs: number
      toMs: number
      limit?: number
    }) => {
      windowReads.push({ fromMs, toMs, ...(limit === undefined ? {} : { limit }) })
      const rows = ALL_EVENTS.filter(
        (event) => Number(event.occurredAt) >= fromMs && Number(event.occurredAt) < toMs,
      )
      // The real query's `LIMIT`, standing in at test scale. `undefined` means
      // uncapped, exactly as it does in the store.
      const effective = limit === undefined ? Number.POSITIVE_INFINITY : Math.min(limit, FAKE_CAP)
      const taken = Number.isFinite(effective) ? rows.slice(0, effective) : rows
      const last = taken[taken.length - 1]
      return await Promise.resolve({
        events: taken,
        truncated: Number.isFinite(effective) && taken.length >= effective,
        lastOccurredMs: last === undefined ? null : Number(last.occurredAt),
      })
    },
    readStoredFacts: async ({ fromMs, toMs }: { siteId: string; fromMs: number; toMs: number }) => {
      storedReads.push({ fromMs, toMs })
      return await Promise.resolve(
        STORED_FACTS.filter((fact) => fact.startMs >= fromMs && fact.startMs < toMs),
      )
    },
    insertFactVersions: async (rows: readonly SessionFactRow[]) => {
      written.push(...rows)
      await Promise.resolve()
    },
    aggregateRollupBuckets: async () => await Promise.resolve([]),
    readStoredRollups: async () => await Promise.resolve([]),
    insertRollups: async () => {
      await Promise.resolve()
    },
  } as unknown as SessionFactsStore

  const state: FinalizerState = {
    claim: async () => await Promise.resolve({ finalizedThroughMs: watermark, runSeq: 0 }),
    advance: async (_siteId, throughMs) => {
      watermark = throughMs
      await Promise.resolve()
    },
    release: async () => {
      await Promise.resolve()
    },
  }

  const { logger } = createCapturedLogger()
  return {
    windowReads,
    storedReads,
    written,
    watermark: () => watermark,
    deps: {
      store,
      state,
      filterFinalizable: async (siteIds) => await Promise.resolve([...siteIds]),
      sessionConfig: loadSessionConfig(),
      latenessMs: 24 * HOUR,
      logger,
      metrics: createRecordingMetrics(),
      now: () => new Date(NOW),
    },
  }
}

let h: Harness
beforeEach(() => {
  h = harness()
})

describe('a truncated recompute window', () => {
  it('asks ClickHouse for a bounded, capped page instead of everything', async () => {
    await finalizeSite(h.deps, SITE)

    const first = h.windowReads[0]
    expect(first?.fromMs).toBe(WATERMARK_START)
    // An upper bound and a row cap. Their absence is the whole out-of-memory
    // bug: `[watermark, infinity)` with no limit.
    expect(first?.toMs).toBe(NOW)
    expect(first?.limit).toBe(200_000)
  })

  it('reads stored facts over the same window it read events for', async () => {
    await finalizeSite(h.deps, SITE)

    // Not `NOW`. A stored fact after the truncation boundary belongs to events
    // this run never loaded, and step 3 tombstones every stored session missing
    // from the recomputed set.
    expect(h.storedReads[0]).toEqual({ fromMs: WATERMARK_START, toMs: BOUNDARY_MS })
  })

  it('writes no retraction for the sessions beyond the boundary', async () => {
    const result = await finalizeSite(h.deps, SITE)

    expect(result.retracted).toBe(0)
    expect(h.written.filter((row) => row.retracted === 1)).toEqual([])
  })

  it('advances the watermark partially — past the rows it read, never past the rest', async () => {
    const result = await finalizeSite(h.deps, SITE)

    // Forward: the point of the cap is that a backlog drains rather than
    // stalling at bounded memory instead of stalling at an OOM.
    expect(result.finalizedThroughMs).toBeGreaterThan(WATERMARK_START)
    // But never past what was actually read. Anything beyond this is a claim to
    // have finalized events that were never loaded, and they would never be
    // sessionized by anyone.
    expect(result.finalizedThroughMs).toBeLessThan(BOUNDARY_MS)
  })

  it('drains the backlog across successive runs and then catches up', async () => {
    const first = await finalizeSite(h.deps, SITE)
    const second = await finalizeSite(h.deps, SITE)

    // The second run starts where the first stopped and, with the remainder now
    // under the cap, reads all the way to the clock.
    expect(h.windowReads[1]?.fromMs).toBe(first.finalizedThroughMs)
    expect(h.windowReads[1]?.toMs).toBe(NOW)
    expect(second.finalizedThroughMs).toBeGreaterThan(first.finalizedThroughMs)
    // Caught up: the horizon is now the ordinary lateness-and-inactivity one.
    expect(second.finalizedThroughMs).toBe(NOW - 24 * HOUR - 30 * 60_000)
    // And still nothing retracted, on either pass.
    expect(h.written.filter((row) => row.retracted === 1)).toEqual([])
  })

  it('leaves an uncut window entirely alone', async () => {
    // The same site once the backlog is gone: fewer rows than the cap, so the
    // page is complete and the bound is the clock. The cap must be inert here,
    // or it would be shortening every healthy window in production.
    const first = await finalizeSite(h.deps, SITE)
    await finalizeSite(h.deps, SITE)

    // `first.finalizedThroughMs`, not the second run's: the reads happen before
    // the advance, so the bound in play is the watermark this run started from.
    expect(h.storedReads[1]).toEqual({ fromMs: first.finalizedThroughMs, toMs: NOW })
  })
})
