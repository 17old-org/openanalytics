import { eq, sql } from 'drizzle-orm'
import type { Database, Executor } from '../client.ts'
import { newId } from '../ids.ts'
import { outbox, type OutboxStatus } from '../schema/outbox.ts'

/**
 * Outbox repository.
 *
 * The producer side (`enqueueOutbox`) is idempotent on `idempotency_key`: a
 * retried enqueue with the same key inserts nothing, which is what lets a caller
 * write the side effect in the same transaction as its state change without
 * fearing a duplicate on retry. The consumer side claims due rows with
 * `FOR UPDATE SKIP LOCKED` so two workers never deliver the same row.
 *
 * These are the only functions that touch the outbox table; the integrations
 * package holds the delivery orchestration and never imports this package, so
 * the worker composes the two.
 */

export interface EnqueueOutboxInput {
  readonly topic: string
  readonly payload: Record<string, unknown>
  readonly idempotencyKey: string
  /** Defaults to immediately due. */
  readonly availableAt?: Date
}

export interface EnqueueOutboxResult {
  readonly enqueued: boolean
  readonly id: string | null
}

export async function enqueueOutbox(
  db: Executor,
  input: EnqueueOutboxInput,
): Promise<EnqueueOutboxResult> {
  const inserted = await db
    .insert(outbox)
    .values({
      id: newId(),
      topic: input.topic,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      ...(input.availableAt === undefined ? {} : { availableAt: input.availableAt }),
    })
    .onConflictDoNothing({ target: outbox.idempotencyKey })
    .returning({ id: outbox.id })

  const row = inserted[0]
  return { enqueued: row !== undefined, id: row?.id ?? null }
}

export interface ClaimedOutboxRow {
  readonly id: string
  readonly payload: unknown
}

/**
 * Atomically claims up to `limit` due rows of a topic, moving them to
 * `processing` and counting the attempt. `SKIP LOCKED` means concurrent workers
 * take disjoint rows instead of blocking.
 */
export async function claimDueOutbox(
  db: Database,
  params: { topic: string; limit: number },
): Promise<ClaimedOutboxRow[]> {
  const result = await db.execute(sql`
    UPDATE ${outbox} AS o
    SET status = 'processing', attempts = o.attempts + 1
    WHERE o.id IN (
      SELECT id FROM ${outbox}
      WHERE topic = ${params.topic} AND status = 'pending' AND available_at <= now()
      ORDER BY available_at
      LIMIT ${params.limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING o.id, o.payload
  `)

  const rows = (result as unknown as { rows: { id: string; payload: unknown }[] }).rows
  return rows.map((row) => ({ id: row.id, payload: row.payload }))
}

/**
 * Default lease: a row claimed longer ago than this is presumed abandoned.
 *
 * Five minutes, against a healthy drain that settles a row in well under a
 * second — three orders of magnitude of headroom, so this cannot reclaim a row
 * from a worker that is merely slow. It is also short enough that a magic link
 * reclaimed at the far end of it is still inside its fifteen-minute lifetime.
 */
const DEFAULT_OUTBOX_LEASE_SECONDS = 300

export interface ReclaimStalledOutboxOptions {
  /** Defaults to `DEFAULT_OUTBOX_LEASE_SECONDS`. */
  readonly staleAfterSeconds?: number
  /** Defaults to 5, matching `markOutboxFailed`. */
  readonly maxAttempts?: number
}

/**
 * Return rows abandoned in `processing` to the queue — the outbox's missing
 * crash-recovery path.
 *
 * ## The hole this fills
 *
 * There were exactly two ways out of `processing`, `markOutboxDelivered` and
 * `markOutboxFailed`, and BOTH require the claiming process to still be alive.
 * A worker that died between the claim and the settle left its row in
 * `processing` **forever**: no timeout, no lease, no sweeper. On 2026-08-22 the
 * worker died 111 times in an out-of-memory loop and five emails — three of
 * them sign-in links — were stranded there for two days, invisible to every
 * alert because only `pending` and `dead` were watched.
 *
 * Deliberately NOT scoped to a topic. Every drain in the process shares this
 * defect, including `realtime.access_revoked`, which has its own loop and no
 * sweeper of its own; a topic filter would fix the caller's topic and leave the
 * others exactly as they were.
 *
 * ## Why a row can go straight to `dead`
 *
 * A row whose attempts are already spent is not returned to `pending`, because
 * a payload that kills the worker WOULD be re-claimed, kill it again, and be
 * re-claimed — a reclaim loop built out of the crash-recovery mechanism. It is
 * settled `dead` instead, which is terminal, worth alerting on by count, and
 * the same verdict `markOutboxFailed` reaches for the same `attempts`. The one thing this must never do is leave a row in
 * `processing` that nothing will ever touch again — that is the bug, not the
 * fix.
 *
 * ## At-least-once, and what pays for it
 *
 * A reclaim cannot distinguish "died before sending" from "sent, then died
 * before recording it", so it must assume the first. The second is covered one
 * layer up: `processEmailOutbox` passes the row id to the transport as an
 * idempotency key, and Resend deduplicates on it for 24 hours — far outside
 * this five-minute lease. See `packages/integrations/src/email.ts`.
 */
export async function reclaimStalledOutbox(
  db: Database,
  options: ReclaimStalledOutboxOptions = {},
): Promise<number> {
  const staleAfterSeconds = options.staleAfterSeconds ?? DEFAULT_OUTBOX_LEASE_SECONDS
  const maxAttempts = options.maxAttempts ?? 5

  const result = await db.execute(sql`
    UPDATE ${outbox}
    SET status = CASE WHEN attempts >= ${maxAttempts} THEN 'dead' ELSE 'pending' END,
        last_error = 'reclaimed from processing after the claiming worker stopped responding'
    WHERE status = 'processing'
      AND available_at < now() - (${staleAfterSeconds} * interval '1 second')
    RETURNING id
  `)

  // `available_at` is left where it was, on purpose, twice over: the row is due
  // immediately (it was already overdue), and the backlog gauge goes on
  // measuring lateness from the original deadline, so a row that keeps being
  // reclaimed reports a lateness that keeps growing rather than resetting to
  // zero on every sweep.
  return (result as unknown as { rows: { id: string }[] }).rows.length
}

export interface OutboxBacklogRow {
  readonly topic: string
  readonly status: 'pending' | 'processing' | 'dead'
  readonly count: number
  /** Age of the oldest row in the group, by `available_at` — lateness, not age. */
  readonly oldestAgeMs: number
}

/**
 * The undelivered backlog, per topic and status.
 *
 * ## `available_at`, not `created_at`: lateness rather than age
 *
 * This measured `created_at` until it was found to cry wolf, and the difference
 * is the difference between "this row exists" and "this row is late". Some rows
 * are *written today to be sent next week* — a scheduled notice with an
 * `available_at` days out — and under `created_at` such a row was born already
 * violating a fifteen-minute stall threshold. That is not a hypothetical: one
 * reminder enqueued a day before its due time held the stalled alert open from
 * the moment it was written, and resolved itself when its due time arrived and
 * the drain sent it. An alert that fires because a scheduled thing is scheduled
 * teaches an operator to close it unread.
 *
 * The failures this still catches, which is why the change is safe:
 *
 *   * A row nothing is claiming. Its `available_at` is in the past and recedes
 *     further every second — exactly the shape `created_at` had.
 *   * A row stuck in `processing`. `claimDueOutbox` does not touch
 *     `available_at` when it claims, so the age of a row whose worker died goes
 *     on growing from when it first became due.
 *
 * The one case it deliberately stops catching is a row in its retry backoff:
 * `markOutboxFailed` pushes `available_at` a minute out, so a retrying row now
 * reports a small (or negative) lateness instead of an ever-growing age. That
 * failure is covered better elsewhere — five attempts take it to `dead` in
 * about five minutes, and the signal worth watching there is the COUNT of dead
 * rows, not any age. Trading a duplicate signal for the removal of a standing
 * false positive is the whole of this decision.
 *
 * `processing` is included because a claimed row whose worker died stays in that
 * state until `reclaimStalledOutbox` above returns it — and it is the status a
 * five-minute lease still leaves a five-minute window on, so it stays watched.
 */
export async function readOutboxBacklog(db: Database): Promise<OutboxBacklogRow[]> {
  const result = await db.execute(sql`
    SELECT topic,
           status,
           count(*)::int AS count,
           (extract(epoch FROM (now() - min(available_at))) * 1000)::bigint AS oldest_age_ms
      FROM ${outbox}
     WHERE status IN ('pending', 'processing', 'dead')
     GROUP BY topic, status
  `)

  const rows = (
    result as unknown as {
      rows: { topic: string; status: string; count: number; oldest_age_ms: string }[]
    }
  ).rows

  return rows.map((row) => ({
    topic: row.topic,
    status: row.status as OutboxBacklogRow['status'],
    count: Number(row.count),
    oldestAgeMs: Number(row.oldest_age_ms),
  }))
}

export interface OutboxDeliveryRow {
  readonly id: string
  readonly topic: string
  /**
   * The payload's `kind`, and deliberately nothing else from the payload.
   *
   * Every email this deployment sends shares one topic (`email.send`), so the
   * topic cannot tell a test send from a sign-in link — the `kind` can, and a
   * caller that serves one kind can refuse the rest. It is extracted here rather
   * than by handing the payload out, because the payload also holds the
   * recipient, the subject and the body, and none of those has any business
   * leaving this function.
   *
   * `null` when the payload is not an object or names no kind, which is a row no
   * caller should match on.
   */
  readonly kind: string | null
  readonly status: OutboxStatus
  readonly attempts: number
  /** The categorized reason a transport reported. Never a raw provider body —
   * `classifySmtpFailure` and the Resend adapter both narrow before this is
   * written, which is what makes it safe to render to an operator. */
  readonly lastError: string | null
  readonly deliveredAt: Date | null
}

/**
 * One outbox row, by id.
 *
 * The read behind "did my test email arrive?". Nothing else needs it: delivery
 * is otherwise a fire-and-forget side effect whose failures belong in the
 * worker's logs.
 *
 * `topic` and `kind` are both returned so the caller can refuse anything it does
 * not serve. Both, because neither is sufficient alone: every email in this
 * system shares the topic `email.send`, so the topic separates mail from future
 * non-mail topics and the `kind` separates a test send from a sign-in link.
 *
 * What this row deliberately does **not** carry is the payload itself — no
 * recipient, no subject, no body — so even a row a caller matches discloses only
 * whether it was delivered and, if not, the reason a transport had already
 * categorized.
 */
export async function readOutboxDelivery(
  db: Database,
  id: string,
): Promise<OutboxDeliveryRow | null> {
  const [row] = await db
    .select({
      id: outbox.id,
      topic: outbox.topic,
      payload: outbox.payload,
      status: outbox.status,
      attempts: outbox.attempts,
      lastError: outbox.lastError,
      deliveredAt: outbox.deliveredAt,
    })
    .from(outbox)
    .where(eq(outbox.id, id))
  if (!row) return null
  const { payload, ...rest } = row
  const kind =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? ((payload as Record<string, unknown>)['kind'] ?? null)
      : null
  return {
    ...rest,
    // Destructured out above and never spread, so no future field added to the
    // payload can reach a response by being carried along.
    kind: typeof kind === 'string' ? kind : null,
    deliveredAt: rest.deliveredAt ? new Date(rest.deliveredAt) : null,
  }
}

export async function markOutboxDelivered(db: Database, id: string): Promise<void> {
  await db
    .update(outbox)
    .set({ status: 'delivered', deliveredAt: new Date(), lastError: null })
    .where(eq(outbox.id, id))
}

export interface MarkOutboxFailedOptions {
  /** Attempts at or beyond this move the row to `dead` instead of retrying. */
  readonly maxAttempts?: number
  readonly retryDelaySeconds?: number
  /**
   * The failure will never succeed on a later attempt, so retry it zero more
   * times and end it at `failed` rather than `dead`.
   *
   * The two terminal statuses are not synonyms and the caller is the only layer
   * that can tell them apart. `dead` means *we* could not deliver — the
   * transport was down, the credential was refused, five attempts were spent
   * against a working system — and it pages `critical`, because a magic link
   * sitting in it is a customer who cannot sign in. `failed` means the message
   * was never deliverable in the first place: a payload that does not parse, an
   * address the provider rejects as malformed. Retrying either is arithmetic
   * with a known answer, and waking someone up for the second is asking them to
   * fix a stranger's typo.
   *
   * `available_at` is left untouched for these, unlike the retry path: nothing
   * will claim the row again, and moving its deadline forward would only
   * misdate the record of when it stopped.
   */
  readonly terminal?: boolean
}

/**
 * Requeues a failed row for a later attempt, or ends it — at `failed` when the
 * caller says the failure is permanent, at `dead` once it has exhausted its
 * attempts. `attempts` was already incremented at claim time, so it reflects the
 * attempt that just failed.
 */
export async function markOutboxFailed(
  db: Database,
  id: string,
  error: string,
  options: MarkOutboxFailedOptions = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 5
  const retryDelaySeconds = options.retryDelaySeconds ?? 60
  // Branched in TypeScript rather than parameterized into a `CASE WHEN $n`: the
  // condition is known before the statement is built, and a JS boolean crossing
  // into SQL as a parameter would have to be trusted to arrive typed.
  const status = options.terminal
    ? sql`'failed'`
    : sql`CASE WHEN attempts >= ${maxAttempts} THEN 'dead' ELSE 'pending' END`
  const availableAt = options.terminal
    ? sql`available_at`
    : sql`now() + (${retryDelaySeconds} * interval '1 second')`
  await db.execute(sql`
    UPDATE ${outbox}
    SET status = ${status},
        available_at = ${availableAt},
        last_error = ${error}
    WHERE id = ${id}
  `)
}
