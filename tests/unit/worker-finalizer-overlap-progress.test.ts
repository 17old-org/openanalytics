import { loadSessionConfig, sessionize, type SessionizerEvent } from '@openanalytics/domain'
import type {
  SessionFactRow,
  SessionFactsStore,
  StoredSessionFact,
} from '@openanalytics/clickhouse'
import { createRecordingMetrics } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'
import type { FinalizerDeps } from '../../apps/worker/src/sessions/deps.ts'
import { finalizeSite } from '../../apps/worker/src/sessions/finalizer.ts'

const SITE = '11111111-1111-1111-1111-111111111111'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = Date.parse('2026-10-20T12:00:00.000Z')
const FROM = Date.parse('2026-09-28T00:24:17.919Z')
const config = loadSessionConfig({})
const epoch = (value: string) => Date.parse(value.replace(' ', 'T') + 'Z')

function stored(row: SessionFactRow): StoredSessionFact {
  return {
    sessionId: row.session_id,
    version: row.version,
    startMs: epoch(row.session_start),
    endMs: epoch(row.session_end),
    visitorId: row.visitor_id,
    userId: row.user_id,
    anonymousId: row.anonymous_id,
    sessionHint: row.session_hint,
    sessionHints: row.session_hints,
    eventIds: row.event_ids,
    midnightBridged: row.midnight_bridged,
    pageviews: row.pageviews,
    engaged: row.engaged,
    activeDurationMs: row.active_duration_ms,
    sessionDurationMs: row.session_duration_ms,
    entryPagePath: row.entry_page_path,
    exitPagePath: row.exit_page_path,
    referrerDomain: row.referrer_domain,
    utmSource: row.utm_source,
    utmMedium: row.utm_medium,
    utmCampaign: row.utm_campaign,
    utmContent: row.utm_content,
    utmTerm: row.utm_term,
    deviceType: row.device_type,
    browser: row.browser,
    os: row.os,
    country: row.country,
    city: row.city,
    finalized: row.finalized,
    retracted: row.retracted,
  }
}

function event(id: string, at: number, anon: string, hint = anon, userId = ''): SessionizerEvent {
  return {
    eventId: id,
    occurredAt: at,
    type: 'page_view',
    anonymousId: anon,
    sessionHint: hint,
    userId,
    pagePath: '/',
  }
}

function harness(
  events: SessionizerEvent[],
  cap = 16,
  initialWatermark = FROM,
  sessionConfig = config,
) {
  const facts = new Map<string, SessionFactRow>()
  let watermark = initialWatermark
  let now = NOW
  let writes = 0
  const reads: { fromMs: number; toMs: number }[] = []
  const store = {
    async readWindowEvents({
      fromMs,
      toMs,
      limit,
    }: {
      fromMs: number
      toMs: number
      limit?: number
    }) {
      reads.push({ fromMs, toMs })
      const all = events
        .filter((e) => Number(e.occurredAt) >= fromMs && Number(e.occurredAt) < toMs)
        .sort(
          (a, b) =>
            Number(a.occurredAt) - Number(b.occurredAt) || a.eventId.localeCompare(b.eventId),
        )
      const size = limit === undefined ? Infinity : Math.min(cap, limit)
      const page = all.slice(0, size)
      return {
        events: page,
        truncated: page.length >= size,
        lastOccurredMs: page.length ? Number(page.at(-1)!.occurredAt) : null,
      }
    },
    async readStoredFacts({ fromMs, toMs }: { fromMs: number; toMs: number }) {
      return [...facts.values()].map(stored).filter((s) => s.startMs >= fromMs && s.startMs < toMs)
    },
    async readFinalizedSessionTails({ fromMs }: { fromMs: number }) {
      return [...facts.values()]
        .map(stored)
        .filter(
          (s) => s.startMs < fromMs && s.endMs >= fromMs && s.finalized === 1 && s.retracted === 0,
        )
        .map((s) => ({ sessionId: s.sessionId, eventIds: s.eventIds }))
    },
    async insertFactVersions(rows: readonly SessionFactRow[]) {
      for (const row of rows) {
        const before = facts.get(row.session_id)
        if (!before || row.version > before.version) facts.set(row.session_id, row)
      }
      writes += rows.length
    },
    aggregateRollupBuckets: async () => [],
    readStoredRollups: async () => [],
    insertRollups: async () => {},
  } as unknown as SessionFactsStore
  const deps: FinalizerDeps = {
    store,
    sessionConfig,
    latenessMs: 24 * HOUR,
    state: {
      claim: async () => ({ finalizedThroughMs: watermark, runSeq: 0 }),
      advance: async (_siteId, through) => {
        watermark = Math.max(watermark, through)
      },
      release: async () => {},
    },
    filterFinalizable: async (ids) => [...ids],
    logger: createCapturedLogger().logger,
    metrics: createRecordingMetrics(),
    now: () => new Date(now),
  }
  return {
    deps,
    facts,
    reads,
    watermark: () => watermark,
    writes: () => writes,
    setWatermark: (value: number) => {
      watermark = value
    },
    setNow: (value: number) => {
      now = value
    },
  }
}

function overlappingEvents(start = FROM, count = 36): SessionizerEvent[] {
  return Array.from({ length: count }, (_, index) => [
    event(`v${index}-start`, start + index * 10 * MINUTE, `v${index}`),
    event(`v${index}-end`, start + (index * 10 + 20) * MINUTE, `v${index}`),
  ]).flat()
}

async function drain(h: ReturnType<typeof harness>, maxRuns = 100) {
  for (let run = 0; run < maxRuns && h.watermark() < NOW - 24 * HOUR - 30 * MINUTE; run++) {
    const before = h.watermark()
    await finalizeSite(h.deps, SITE)
    expect(h.watermark(), `no progress on pass ${run}`).toBeGreaterThan(before)
  }
  expect(h.watermark()).toBe(NOW - 24 * HOUR - 30 * MINUTE)
}

function expectCanonical(h: ReturnType<typeof harness>, events: SessionizerEvent[]) {
  const expected = sessionize(SITE, events, h.deps.sessionConfig)
  const actual = [...h.facts.values()].filter((row) => row.retracted === 0)
  expect(actual.map((row) => row.session_id).sort()).toEqual(
    expected.map((s) => s.sessionId).sort(),
  )
  const ids = actual.flatMap((row) => row.event_ids)
  expect(ids.length).toBe(new Set(ids).size)
  expect(ids.sort()).toEqual(events.map((e) => e.eventId).sort())
  expect(actual.reduce((total, row) => total + row.pageviews, 0)).toBe(events.length)
}

describe('capped finalizer progress with exact closed-tail membership', () => {
  it('drains continuous overlap without duplicating tails, then becomes a no-op', async () => {
    const events = overlappingEvents()
    const h = harness(events)
    await finalizeSite(h.deps, SITE)
    expect(
      [...h.facts.values()].some(
        (row) =>
          epoch(row.session_start) < h.watermark() &&
          epoch(row.session_end) === h.watermark() &&
          row.finalized === 1,
      ),
    ).toBe(true)
    await drain(h)
    expect(h.reads.length).toBeGreaterThan(2)
    expectCanonical(h, events)
    const writes = h.writes()
    await finalizeSite(h.deps, SITE)
    expect(h.writes()).toBe(writes)
  })

  it('preserves cap phase, midnight bridging and identify stitching across cuts', async () => {
    const start = Date.parse('2026-09-28T23:00:00.000Z')
    const events = overlappingEvents(start, 160)
    // This visitor crosses many cuts and the 24h cap. A fixed lookback or an
    // identity approximation can shift its cap phase or lose the anonymous tail.
    for (let index = 0; index <= 80; index++)
      events.push(event(`long-${index}`, start + index * 20 * MINUTE, 'long'))
    const midnight = Date.parse('2026-09-29T00:00:00.000Z')
    events.push(event('rotate-before', midnight - 5 * MINUTE, 'rotated-a', 'shared-hint'))
    events.push(event('rotate-after', midnight + 5 * MINUTE, 'rotated-b', 'shared-hint'))
    events.push(
      event('identify-after', midnight + 10 * MINUTE, 'rotated-b', 'shared-hint', 'user-a'),
    )
    events.push(event('plain-before', midnight - 7 * MINUTE, 'plain-a', 'plain-shared'))
    events.push(event('plain-after', midnight + 6 * MINUTE, 'plain-b', 'plain-shared'))
    // Scale the session cap with the small fake row cap: the production
    // incident's capped prefix spans >24h, so its 24h sessions fit in a prefix.
    const h = harness(events, 40, start, loadSessionConfig({ SESSION_MAX_LENGTH_HOURS: '1' }))
    await drain(h)
    expectCanonical(h, events)
    const stitched = [...h.facts.values()].find((row) => row.event_ids.includes('rotate-before'))!
    expect(stitched.user_id).toBe('user-a')
    expect(
      [...h.facts.values()].find((row) => row.event_ids.includes('plain-before'))?.midnight_bridged,
    ).toBe(1)
    expect(stitched.event_ids).toContain('identify-after')
  })

  it('rewrites legacy in-window membership before allowing a crossing tail', async () => {
    const events = overlappingEvents()
    const h = harness(events)
    await finalizeSite(h.deps, SITE)
    const oldWatermark = h.watermark()
    for (const [id, row] of h.facts) h.facts.set(id, { ...row, event_ids: [] })
    // A normal old-worker upgrade resumes from its existing safe watermark;
    // legacy facts in that recompute window must acquire membership first.
    h.setWatermark(FROM)
    await finalizeSite(h.deps, SITE)
    expect(h.watermark()).toBe(oldWatermark)
    expect([...h.facts.values()].every((row) => row.event_ids.length > 0)).toBe(true)
    await drain(h)
    expectCanonical(h, events)
  })

  it('fails closed on a pre-existing closed tail with unknown membership', async () => {
    const h = harness(overlappingEvents())
    await finalizeSite(h.deps, SITE)
    const tail = [...h.facts.values()].find(
      (row) =>
        epoch(row.session_start) < h.watermark() &&
        epoch(row.session_end) >= h.watermark() &&
        row.finalized === 1,
    )!
    expect(tail).toBeDefined()
    h.facts.set(tail.session_id, { ...tail, event_ids: [] })
    const before = h.watermark()
    await expect(finalizeSite(h.deps, SITE)).rejects.toThrow(
      'session_finalized_tail_membership_missing',
    )
    expect(h.watermark()).toBe(before)
  })

  it('retracts the old id after a late earlier event and preserves exact membership', async () => {
    const start = NOW - HOUR
    const events = [event('initial', start, 'late')]
    const h = harness(events, 16, NOW - 30 * HOUR)
    await finalizeSite(h.deps, SITE)
    const oldId = [...h.facts.keys()][0]!
    events.push(event('earlier', start - 5 * MINUTE, 'late'))
    await finalizeSite(h.deps, SITE)
    expect(h.facts.get(oldId)?.retracted).toBe(1)
    expectCanonical(h, events)
    const writes = h.writes()
    await finalizeSite(h.deps, SITE)
    expect(h.writes()).toBe(writes)
  })
})
