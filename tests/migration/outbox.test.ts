import {
  claimDueOutbox,
  createDatabase,
  createPool,
  enqueueOutbox,
  markOutboxDelivered,
  markOutboxFailed,
  newId,
  readOutboxBacklog,
  reclaimStalledOutbox,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createRecordingMetrics } from '@openanalytics/observability'
import {
  EMAIL_OUTBOX_TOPIC,
  buildVerificationEmailPayload,
  processEmailOutbox,
  selectEmailTransport,
  type EmailOutboxStore,
} from '@openanalytics/integrations'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_OUTBOX_TOPICS, drainOutboxTopic } from '../../apps/worker/src/outbox-dispatcher.ts'

/**
 * The outbox path against a real Postgres: idempotent enqueue, locked claim, and
 * a full enqueue → drain → deliver run through the log transport. This is the
 * database half of "email must go through the outbox"; the request-side wiring
 * and its HTTP test come with the API mount.
 */

/** The policy the handlers read; the defaults `policySchema` declares. */
const POLICY = {
  blockIngestGraceHours: 24,
  blockedDataRetentionDays: 90,
  productName: 'Open Analytics',
} as const

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

describeIfPostgres('outbox repository', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m2outbox_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database

  const emailStore = (database: Database): EmailOutboxStore => ({
    claimDue: (limit) => claimDueOutbox(database, { topic: EMAIL_OUTBOX_TOPIC, limit }),
    markDelivered: (id) => markOutboxDelivered(database, id),
    markFailed: (id, reason) => markOutboxFailed(database, id, reason),
  })

  const enqueueVerification = (to: string, token: string) =>
    enqueueOutbox(db, {
      topic: EMAIL_OUTBOX_TOPIC,
      payload: buildVerificationEmailPayload({
        to,
        url: `https://api.test/verify?token=${token}`,
        productName: 'Acme Metrics',
      }) as unknown as Record<string, unknown>,
      idempotencyKey: `email.verification:${token}`,
    })

  const statusOf = async (idempotencyKey: string) => {
    const result = await pool.query<{
      status: string
      attempts: number
      last_error: string | null
      available_at: Date
    }>(`SELECT status, attempts, last_error, available_at FROM outbox WHERE idempotency_key = $1`, [
      idempotencyKey,
    ])
    return result.rows[0]
  }

  beforeAll(async () => {
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`)
    } finally {
      await admin.end()
    }

    const url = new URL(connectionString)
    url.searchParams.set('options', `-c search_path=${schemaName}`)
    const scoped = url.toString()

    const { logger } = createCapturedLogger()
    await applyPostgresStreams({ connectionString: scoped, logger })

    pool = createPool(scoped)
    db = createDatabase(pool)
  })

  afterAll(async () => {
    await pool?.end()
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
    } finally {
      await admin.end()
    }
  })

  it('enqueues idempotently on the idempotency key', async () => {
    const first = await enqueueVerification('a@example.com', 'idem-1')
    const second = await enqueueVerification('a@example.com', 'idem-1')

    expect(first.enqueued).toBe(true)
    expect(second.enqueued).toBe(false)

    const count = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox WHERE idempotency_key = 'email.verification:idem-1'`,
    )
    expect(count.rows[0]?.n).toBe('1')
  })

  it('delivers a due email through the transport and marks it delivered', async () => {
    await enqueueVerification('b@example.com', 'deliver-1')

    const transport = selectEmailTransport({ defaultFrom: 'noreply@test' })
    const result = await processEmailOutbox({ store: emailStore(db), transport })

    expect(result.delivered).toBeGreaterThanOrEqual(1)
    expect(await statusOf('email.verification:deliver-1')).toMatchObject({ status: 'delivered' })
  })

  it('requeues a transient failure and buries an exhausted one', async () => {
    await enqueueVerification('c@example.com', 'retry-1')
    const claimed = await claimDueOutbox(db, { topic: EMAIL_OUTBOX_TOPIC, limit: 10 })
    const target = claimed.find((row) => {
      const payload = row.payload as { to?: string }
      return payload.to === 'c@example.com'
    })
    expect(target).toBeDefined()

    if (target) {
      await markOutboxFailed(db, target.id, 'smtp down')
      expect(await statusOf('email.verification:retry-1')).toMatchObject({
        status: 'pending',
        attempts: 1,
        last_error: 'smtp down',
      })

      // With a single-attempt ceiling the same failed row is buried, not retried.
      await markOutboxFailed(db, target.id, 'smtp down', { maxAttempts: 1 })
      expect(await statusOf('email.verification:retry-1')).toMatchObject({ status: 'dead' })
    }
  })

  it('ends a permanent failure at failed, without spending the attempts it has left', async () => {
    // `dead` and `failed` are not synonyms and the difference is who has to act.
    // `dead` pages `critical` — five attempts spent against a system that should
    // have worked, and a magic link inside one means a customer who cannot sign
    // in. `failed` is a message that was never deliverable: a payload that does
    // not parse, an address the provider refuses. Retrying either is arithmetic
    // with a known answer, so a terminal failure ends on the first one.
    await enqueueVerification('d@example.com', 'terminal-1')
    const claimed = await claimDueOutbox(db, { topic: EMAIL_OUTBOX_TOPIC, limit: 10 })
    const target = claimed.find((row) => {
      const payload = row.payload as { to?: string }
      return payload.to === 'd@example.com'
    })
    expect(target).toBeDefined()

    if (target) {
      const before = await statusOf('email.verification:terminal-1')
      await markOutboxFailed(db, target.id, 'invalid', { terminal: true })
      const after = await statusOf('email.verification:terminal-1')

      // One attempt of a five-attempt budget, and it is already over.
      expect(after).toMatchObject({ status: 'failed', attempts: 1, last_error: 'invalid' })
      // `available_at` is left where it was rather than pushed a minute out:
      // nothing will claim the row again, and moving the deadline would only
      // misdate when it stopped.
      expect(after?.available_at).toEqual(before?.available_at)
    }
  })

  it('drains every topic the generic dispatcher owns', async () => {
    // Before this, `site.ownership_changed` and its siblings had a producer and no
    // consumer: their rows sat `pending` for good, and an outbox nobody drains is a
    // side effect that never happens plus a table that only grows.
    // Identifiers of rows that do not exist, which is the point: every handler
    // has to settle a payload whose subject is gone rather than retry it forever.
    // An ownership change that did not block needs no epoch bump; a deletion notice
    // for a scrubbed subject has nothing left to read.
    //
    // `billing.subscription` and `notification.rapid_burn` were in this list until
    // the open-core split. They are registered by the surface that writes them, so
    // a build without it drains the three below and this is that set.
    const absentUser = newId()
    const absentSite = newId()
    const keys = [
      [
        'site.ownership_changed',
        'site.ownership:site_drain_1:1',
        { siteId: absentSite, status: 'active' },
      ],
      // Observe-only until the email milestone; drained all the same (CP3).
      [
        'site.deletion_completed',
        `site.deletion_completed:${absentSite}`,
        { site_id: absentSite, deletion_request_id: newId() },
      ],
      // Likewise (CP4). The subject is a scrubbed users row by the time this is
      // delivered, which is exactly the "settle a payload whose subject is gone"
      // property the whole test is about.
      [
        'account.deletion_completed',
        `account.deletion_completed:${absentUser}`,
        { user_id: absentUser, deletion_request_id: newId() },
      ],
    ] as const

    for (const [topic, idempotencyKey, payload] of keys) {
      await enqueueOutbox(db, { topic, idempotencyKey, payload })
    }

    const { logger } = createCapturedLogger()
    const metrics = createRecordingMetrics()
    for (const registration of DEFAULT_OUTBOX_TOPICS) {
      const result = await drainOutboxTopic({ db, logger, metrics, policy: POLICY }, registration)
      expect(result.failed).toBe(0)
      expect(result.delivered).toBeGreaterThanOrEqual(1)
    }

    for (const [, idempotencyKey] of keys) {
      expect(await statusOf(idempotencyKey)).toMatchObject({ status: 'delivered' })
    }
  })

  it('reports the undelivered backlog by topic and status', async () => {
    await enqueueOutbox(db, {
      topic: 'notification.rapid_burn',
      idempotencyKey: 'rapid_burn:site_backlog:2026-07-27',
      payload: { site_id: 'backlog' },
      // Old enough that the age is unambiguously non-zero.
      availableAt: new Date(Date.now() - 60_000),
    })

    const rows = await readOutboxBacklog(db)
    const pending = rows.find(
      (row) => row.topic === 'notification.rapid_burn' && row.status === 'pending',
    )
    expect(pending?.count).toBeGreaterThanOrEqual(1)
    // Measured from `available_at`, so the number is LATENESS and not age. The
    // row above was made due a minute ago and is therefore a minute late.
    expect(pending?.oldestAgeMs).toBeGreaterThanOrEqual(60_000)

    const dead = rows.find((row) => row.topic === EMAIL_OUTBOX_TOPIC && row.status === 'dead')
    expect(dead?.count).toBeGreaterThanOrEqual(1)
    // Only the COUNT is meaningful for `dead`, and only the count is alerted on
    // (`oa-email-outbox-dead`). `markOutboxFailed` writes `available_at =
    // now() + retryDelay` on the same statement that buries the row, so a dead
    // row's lateness reads about a minute in the future — a retry slot that will
    // never be used. Asserted so nobody later builds an age rule on this series
    // believing it measures how long the row has been dead.
    expect(dead?.oldestAgeMs).toBeLessThan(0)
  })

  it('does not count a row scheduled for the future as a backlog', async () => {
    // The 2026-08-23 false alarm, as a test. A trial reminder written today and
    // due tomorrow raised `oa-email-outbox-stalled` from the moment it was
    // enqueued, because the gauge measured how OLD the row was rather than how
    // LATE it was, and then resolved itself when its due time arrived. An alert
    // that fires because a scheduled thing is scheduled gets closed unread.
    await enqueueOutbox(db, {
      topic: 'notification.scheduled_probe',
      idempotencyKey: 'scheduled_probe:1',
      payload: { site_id: 'scheduled' },
      availableAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })

    const rows = await readOutboxBacklog(db)
    const row = rows.find((entry) => entry.topic === 'notification.scheduled_probe')

    expect(row?.count).toBe(1)
    // Negative: it is not late, it is early. Every alert on this gauge is a
    // `gt` threshold, so a row that is not yet due cannot trip any of them.
    expect(row?.oldestAgeMs).toBeLessThan(0)
  })

  describe('reclaiming rows abandoned in processing', () => {
    /**
     * Claims a row and then abandons it, as a worker that died mid-delivery
     * does.
     *
     * The topic is per-case rather than shared, and that is not tidiness:
     * `claimDueOutbox` takes every due row of a topic, so a row one case left
     * `pending` gets claimed by the next case's setup and counted in its
     * reclaim. The first version of this suite failed exactly that way.
     */
    const abandon = async (topic: string, idempotencyKey: string, dueSecondsAgo: number) => {
      await enqueueOutbox(db, {
        topic,
        idempotencyKey,
        payload: { probe: idempotencyKey },
        availableAt: new Date(Date.now() - dueSecondsAgo * 1000),
      })
      await claimDueOutbox(db, { topic, limit: 10 })
    }

    it('returns a row whose worker died to pending, and leaves a fresh claim alone', async () => {
      // Two rows, one claim: the difference is only how long ago each fell due,
      // which is what the lease reads.
      await abandon('notification.reclaim_a', 'reclaim:stale', 600)
      await abandon('notification.reclaim_a', 'reclaim:fresh', 0)

      const reclaimed = await reclaimStalledOutbox(db, { staleAfterSeconds: 300 })

      expect(reclaimed).toBe(1)
      // Table-wide, not per-topic, on purpose: every drain in the process has
      // the same defect, including the two the dispatcher does not own.
      expect(await statusOf('reclaim:stale')).toMatchObject({ status: 'pending' })
      // Still `processing`. A worker taking four minutes is slow, not dead, and
      // reclaiming from it is how one delivery becomes two.
      expect(await statusOf('reclaim:fresh')).toMatchObject({ status: 'processing' })
    })

    it('buries a row that has exhausted its attempts instead of looping on it', async () => {
      await abandon('notification.reclaim_b', 'reclaim:exhausted', 600)

      // The dangerous shape: a payload that kills the worker every time it is
      // claimed would be reclaimed, kill it again, and be reclaimed — a crash
      // loop built out of the crash-recovery mechanism. `dead` is terminal and
      // is alerted on by count.
      const reclaimed = await reclaimStalledOutbox(db, {
        staleAfterSeconds: 300,
        maxAttempts: 1,
      })

      expect(reclaimed).toBe(1)
      expect(await statusOf('reclaim:exhausted')).toMatchObject({ status: 'dead' })
    })

    it('leaves no row in processing for a claim older than the lease', async () => {
      // The invariant, stated directly: whatever else it does, the sweep must
      // never leave behind a `processing` row that nothing will touch again.
      // Five such rows survived two days and every alert in production.
      await abandon('notification.reclaim_c', 'reclaim:invariant', 600)

      await reclaimStalledOutbox(db, { staleAfterSeconds: 300, maxAttempts: 1 })

      const stuck = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM outbox
          WHERE status = 'processing' AND available_at < now() - interval '300 seconds'`,
      )
      expect(stuck.rows[0]?.n).toBe('0')
    })
  })
})
