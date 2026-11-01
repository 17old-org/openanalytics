import type { Redis } from 'ioredis'
import { EVENT_STREAM_DLQ_KEY, EVENT_STREAM_GROUP, EVENT_STREAM_KEY } from './keys.ts'
import { parsePendingSummary } from './consumer.ts'
import type { QueueMaintenance } from './queue.ts'

/**
 * Dead-letter and retention operations on the durable queue (plan Milestone 6
 * items 9 and 10; docs snapshot 05, D-216).
 *
 * Kept apart from the consumer because they answer a different question. The
 * consumer is about delivering an event exactly once; this is about how long the
 * evidence of that delivery is kept, and what happens to a batch that could not
 * be delivered at all.
 */

/**
 * The millisecond timestamp encoded in a stream id.
 *
 * Redis stream ids are `<ms>-<seq>`, which is what lets retention be expressed
 * as a `MINID` trim rather than as a scan: the id *is* the timestamp, so the
 * cutoff is computable without reading a single entry.
 */
export function streamIdTimestampMs(id: string): number | null {
  const [millis] = id.split('-')
  const parsed = Number(millis)
  return Number.isFinite(parsed) ? parsed : null
}

export function minIdFor(before: Date): string {
  return `${before.getTime()}-0`
}

/**
 * The earliest of several stream ids, ignoring nulls; null when all are null.
 *
 * Ordered by the encoded timestamp, then by sequence — the order Valkey itself
 * uses — so two ids in the same millisecond still compare correctly.
 */
export function earliestStreamId(...ids: readonly (string | null)[]): string | null {
  let earliest: string | null = null
  for (const id of ids) {
    if (id === null) continue
    if (earliest === null || compareStreamIds(id, earliest) < 0) earliest = id
  }
  return earliest
}

function compareStreamIds(a: string, b: string): number {
  const [aMs = '0', aSeq = '0'] = a.split('-')
  const [bMs = '0', bSeq = '0'] = b.split('-')
  const byMs = Number(aMs) - Number(bMs)
  return byMs !== 0 ? byMs : Number(aSeq) - Number(bSeq)
}

/**
 * Steps the memory-pressure trim may take before giving up for this round.
 *
 * Each step halves the distance to the safe bound, and the last one goes all
 * the way to it, so a full instance is relieved within a handful of round trips
 * while a nearly-full one loses only the oldest slice it needs to.
 */
const MEMORY_TRIM_MAX_STEPS = 5

/** Picks the earlier of the retention cutoff and the oldest pending entry. */
export function safeTrimMinId(retentionMinId: string, oldestPendingId: string | null): string {
  if (oldestPendingId === null) return retentionMinId
  const retention = streamIdTimestampMs(retentionMinId)
  const pending = streamIdTimestampMs(oldestPendingId)
  if (retention === null || pending === null) return oldestPendingId
  return pending < retention ? oldestPendingId : retentionMinId
}

/**
 * `last-delivered-id` of one group out of an `XINFO GROUPS` reply, or null when
 * the group is not in it.
 *
 * The reply is a list of flat `[field, value, …]` arrays, with strings arriving
 * as Buffers on some client configurations — the same shape quirks
 * `parsePendingSummary` absorbs for `XPENDING`.
 */
export function lastDeliveredIdFor(reply: unknown, groupName: string): string | null {
  if (!Array.isArray(reply)) return null
  for (const group of reply) {
    if (!Array.isArray(group)) continue
    let name: string | null = null
    let lastDeliveredId: string | null = null
    for (let index = 0; index + 1 < group.length; index += 2) {
      const field = String(group[index])
      const value = group[index + 1]
      if (field === 'name') name = String(value)
      if (field === 'last-delivered-id') lastDeliveredId = String(value)
    }
    if (name === groupName) return lastDeliveredId
  }
  return null
}

/**
 * One numeric field out of an `INFO` section reply.
 *
 * `INFO` is a text blob, not a typed reply: `# Memory\r\nused_memory:123\r\n…`.
 * Parsed here rather than with `CONFIG GET` because `INFO memory` already
 * carries both halves of the ratio, and `CONFIG` is the command a managed
 * provider is most likely to have taken away.
 *
 * Anchored to the line start so `used_memory` cannot match `used_memory_rss`,
 * `used_memory_peak` or the dozen other fields that share its prefix — the
 * mistake a substring search makes silently, and with a plausible-looking
 * number.
 */
export function infoFieldValue(info: string, field: string): number | null {
  for (const line of info.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(`${field}:`)) continue
    const parsed = Number(trimmed.slice(field.length + 1))
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export interface QueueMaintenanceOptions {
  readonly client: Redis
  readonly streamKey?: string
  readonly groupName?: string
  readonly deadLetterKey?: string
}

export function createQueueMaintenance(options: QueueMaintenanceOptions): QueueMaintenance {
  const { client } = options
  const streamKey = options.streamKey ?? EVENT_STREAM_KEY
  const groupName = options.groupName ?? EVENT_STREAM_GROUP
  const deadLetterKey = options.deadLetterKey ?? EVENT_STREAM_DLQ_KEY

  /**
   * Id of the first entry the consumer group has never delivered, or null when
   * the group has read everything the stream holds.
   */
  const oldestUndeliveredId = async (): Promise<string | null> => {
    const groups = (await client.call('XINFO', 'GROUPS', streamKey)) as unknown[] | null
    const lastDeliveredId = lastDeliveredIdFor(groups, groupName)
    // The group vanishing between XPENDING and XINFO would mean someone is
    // destroying the queue underneath us; treat everything as undelivered
    // rather than reporting a healthy queue.
    const start = lastDeliveredId === null ? '-' : `(${lastDeliveredId}`
    const entries = (await client.call('XRANGE', streamKey, start, '+', 'COUNT', '1')) as
      [string, string[]][] | null
    return entries?.[0]?.[0] ?? null
  }

  return {
    async publishDeadLetter({ batchId, reason, messages }): Promise<number> {
      if (messages.length === 0) return 0

      const pipeline = client.pipeline()
      for (const message of messages) {
        pipeline.call(
          'XADD',
          deadLetterKey,
          '*',
          'batch_id',
          batchId,
          'reason',
          reason,
          'original_id',
          message.id,
          'site_id',
          message.siteId,
          'event_id',
          message.eventId,
          'payload_hash',
          message.payloadHash,
          'accepted_at',
          message.acceptedAt,
          'payload',
          message.payload,
        )
      }
      const replies = await pipeline.exec()
      for (const entry of replies ?? []) {
        const [error] = entry
        if (error) throw error
      }
      return messages.length
    },

    async trimAcked({ before }): Promise<{ trimmed: number; minId: string }> {
      const summary = parsePendingSummary(await client.call('XPENDING', streamKey, groupName))
      // Undelivered entries are protected as well as pending ones: a worker that
      // stopped reading for longer than the horizon would otherwise have events
      // it never stored trimmed away as if they were finished work.
      const minId =
        earliestStreamId(
          safeTrimMinId(minIdFor(before), summary.minId),
          await oldestUndeliveredId(),
        ) ?? minIdFor(before)

      // MINID rather than MAXLEN: retention here is an age, and a length cap
      // would discard by volume — so a traffic spike would silently shorten the
      // disaster-replay window exactly when it matters most.
      const trimmed = await client.call('XTRIM', streamKey, 'MINID', minId)
      return { trimmed: Number(trimmed ?? 0), minId }
    },

    async oldestPendingAgeMs(now: Date): Promise<number | null> {
      const summary = parsePendingSummary(await client.call('XPENDING', streamKey, groupName))

      // A pending entry is one already delivered and not yet ACKed. If there is
      // none, the oldest *undelivered* entry still counts as queue age — a
      // stalled worker that stops reading would otherwise look perfectly
      // healthy, which is the outage this metric exists to catch.
      //
      // Undelivered means past the group's last-delivered-id, NOT merely
      // present in the stream: ACKed payloads are retained for days as the
      // disaster-replay window (docs snapshot 05, D-216), so the stream's
      // oldest entry is normally finished work. Measuring from it kept the
      // G-006 alert firing on a fully drained queue.
      const candidate = summary.minId ?? (await oldestUndeliveredId())
      if (candidate === null) return null
      const at = streamIdTimestampMs(candidate)
      return at === null ? null : Math.max(0, now.getTime() - at)
    },

    async trimForMemory({ now, targetRatio, floorMs }) {
      const ratioBefore = await this.memoryUsageRatio()
      if (ratioBefore === null || ratioBefore <= targetRatio) {
        return { trimmed: 0, ratioBefore, ratioAfter: ratioBefore, minId: null }
      }

      const first = (await client.call('XRANGE', streamKey, '-', '+', 'COUNT', '1')) as
        [string, string[]][] | null
      const oldestId = first?.[0]?.[0] ?? null
      const summary = parsePendingSummary(await client.call('XPENDING', streamKey, groupName))
      // The furthest this trim may ever reach: never past work that is waiting
      // (pending or undelivered), and never into the floor window, whatever the
      // memory reading says — a refused write is recoverable, a lost event is not.
      const bound = earliestStreamId(
        summary.minId,
        await oldestUndeliveredId(),
        minIdFor(new Date(now.getTime() - floorMs)),
      )
      const oldestMs = oldestId === null ? null : streamIdTimestampMs(oldestId)
      const boundMs = bound === null ? null : streamIdTimestampMs(bound)
      if (bound === null || oldestMs === null || boundMs === null || boundMs <= oldestMs) {
        return { trimmed: 0, ratioBefore, ratioAfter: ratioBefore, minId: null }
      }

      let trimmed = 0
      let ratioAfter: number | null = ratioBefore
      let minId: string | null = null
      for (let step = 1; step <= MEMORY_TRIM_MAX_STEPS; step++) {
        minId =
          step === MEMORY_TRIM_MAX_STEPS
            ? bound
            : `${oldestMs + Math.floor((boundMs - oldestMs) * (1 - 2 ** -step))}-0`
        trimmed += Number((await client.call('XTRIM', streamKey, 'MINID', minId)) ?? 0)
        ratioAfter = await this.memoryUsageRatio()
        if (ratioAfter === null || ratioAfter <= targetRatio) break
      }
      return { trimmed, ratioBefore, ratioAfter, minId }
    },

    async memoryUsageRatio(): Promise<number | null> {
      const info = String((await client.call('INFO', 'memory')) ?? '')
      const used = infoFieldValue(info, 'used_memory')
      const max = infoFieldValue(info, 'maxmemory')

      // `maxmemory: 0` is Valkey's "no limit", and there is no ratio to report
      // against infinity. Null, not zero: see the interface docstring.
      if (used === null || max === null || max <= 0) return null
      return used / max
    },
  }
}
