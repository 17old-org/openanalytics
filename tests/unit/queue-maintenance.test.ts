import {
  createQueueMaintenance,
  infoFieldValue,
  lastDeliveredIdFor,
  type QueueMaintenanceOptions,
} from '@openanalytics/redis'
import { describe, expect, it } from 'vitest'

type ClientStub = QueueMaintenanceOptions['client']

const NOW = new Date('2026-07-27T09:00:00.000Z')

/** An XPENDING summary reply: [count, minId, maxId, consumers]. */
function pendingReply(minId: string | null): unknown {
  return minId === null ? [0, null, null, null] : [1, minId, minId, [['worker-1', '1']]]
}

/** An XINFO GROUPS reply with a single group at the given delivery cursor. */
function groupsReply(lastDeliveredId: string): unknown {
  return [
    ['name', 'ingest_workers', 'consumers', 1, 'pending', 0, 'last-delivered-id', lastDeliveredId],
  ]
}

/**
 * A client stub that answers the three commands `oldestPendingAgeMs` may issue
 * and records the XRANGE start bound it was asked for.
 */
function stubClient(replies: {
  pending?: unknown
  groups?: unknown
  range?: unknown
  info?: unknown
}): {
  client: ClientStub
  calls: string[][]
} {
  const calls: string[][] = []
  const client = {
    call: (...args: unknown[]) => {
      const command = args.map(String)
      calls.push(command)
      if (command[0] === 'XPENDING') return Promise.resolve(replies.pending)
      if (command[0] === 'XINFO') return Promise.resolve(replies.groups ?? null)
      if (command[0] === 'XRANGE') return Promise.resolve(replies.range ?? null)
      if (command[0] === 'INFO') return Promise.resolve(replies.info ?? null)
      return Promise.reject(new Error(`unexpected command ${command[0]}`))
    },
  } as unknown as ClientStub
  return { client, calls }
}

/**
 * A realistic `INFO memory` section. Abridged, but the fields kept are the ones
 * that matter: `used_memory` sits above four other fields that START WITH IT,
 * which is the whole reason the parser anchors on the line.
 */
function infoMemoryReply(usedBytes: number, maxBytes: number): string {
  return [
    '# Memory',
    `used_memory:${usedBytes}`,
    `used_memory_human:${(usedBytes / 1024 / 1024).toFixed(2)}M`,
    `used_memory_rss:${usedBytes * 2}`,
    `used_memory_peak:${usedBytes * 3}`,
    `used_memory_lua:${usedBytes * 4}`,
    `maxmemory:${maxBytes}`,
    'maxmemory_policy:noeviction',
    '',
  ].join('\r\n')
}

/**
 * The G-006 gauge must distinguish work that is *waiting* from work that is
 * merely *retained*. ACKed entries stay in the stream for the D-216 replay
 * window, so "oldest stream entry" is days old on a perfectly healthy queue —
 * the miscount that kept the queue-age alert firing on a drained pipeline.
 */
describe('oldestPendingAgeMs', () => {
  it('measures from the oldest pending entry when the PEL is not empty', async () => {
    const { client, calls } = stubClient({
      pending: pendingReply(`${NOW.getTime() - 30_000}-0`),
    })
    const maintenance = createQueueMaintenance({ client })

    expect(await maintenance.oldestPendingAgeMs(NOW)).toBe(30_000)
    // The stream itself is never consulted; pending age is authoritative.
    expect(calls.map((c) => c[0])).toEqual(['XPENDING'])
  })

  it('reports null on a drained queue even when ACKed entries are retained', async () => {
    const lastDelivered = `${NOW.getTime() - 60_000}-0`
    const { client, calls } = stubClient({
      pending: pendingReply(null),
      groups: groupsReply(lastDelivered),
      // Nothing past the delivery cursor: the days-old ACKed entries below it
      // must not be offered by the stub, because the query must exclude them.
      range: [],
    })
    const maintenance = createQueueMaintenance({ client })

    expect(await maintenance.oldestPendingAgeMs(NOW)).toBeNull()
    const range = calls.find((c) => c[0] === 'XRANGE')
    expect(range?.[2]).toBe(`(${lastDelivered}`)
  })

  it('measures from the first undelivered entry when the worker has stopped reading', async () => {
    const lastDelivered = `${NOW.getTime() - 600_000}-0`
    const undelivered = `${NOW.getTime() - 300_000}-0`
    const { client } = stubClient({
      pending: pendingReply(null),
      groups: groupsReply(lastDelivered),
      range: [[undelivered, ['payload', '{}']]],
    })
    const maintenance = createQueueMaintenance({ client })

    expect(await maintenance.oldestPendingAgeMs(NOW)).toBe(300_000)
  })

  it('treats the whole stream as undelivered when the group cannot be found', async () => {
    const oldest = `${NOW.getTime() - 120_000}-0`
    const { client, calls } = stubClient({
      pending: pendingReply(null),
      groups: [],
      range: [[oldest, ['payload', '{}']]],
    })
    const maintenance = createQueueMaintenance({ client })

    expect(await maintenance.oldestPendingAgeMs(NOW)).toBe(120_000)
    const range = calls.find((c) => c[0] === 'XRANGE')
    expect(range?.[2]).toBe('-')
  })

  it('reports null on an empty stream', async () => {
    const { client } = stubClient({
      pending: pendingReply(null),
      groups: groupsReply('0-0'),
      range: [],
    })
    const maintenance = createQueueMaintenance({ client })

    expect(await maintenance.oldestPendingAgeMs(NOW)).toBeNull()
  })
})

describe('lastDeliveredIdFor', () => {
  it('finds the named group in an XINFO GROUPS reply', () => {
    const reply = [
      ['name', 'other_group', 'last-delivered-id', '1-1'],
      ['name', 'ingest_workers', 'last-delivered-id', '2-2'],
    ]
    expect(lastDeliveredIdFor(reply, 'ingest_workers')).toBe('2-2')
  })

  it('reads Buffer field names and values', () => {
    const reply = [
      [
        Buffer.from('name'),
        Buffer.from('ingest_workers'),
        Buffer.from('last-delivered-id'),
        Buffer.from('3-0'),
      ],
    ]
    expect(lastDeliveredIdFor(reply, 'ingest_workers')).toBe('3-0')
  })

  it('answers null for a missing group or a malformed reply', () => {
    expect(lastDeliveredIdFor([], 'ingest_workers')).toBeNull()
    expect(lastDeliveredIdFor(null, 'ingest_workers')).toBeNull()
    expect(lastDeliveredIdFor('OK', 'ingest_workers')).toBeNull()
  })
})

/**
 * The capacity gauge that did not exist on 2026-08-22, when the queue instance
 * reached 100 % of `maxmemory`, `noeviction` turned every write into an error,
 * and the collector returned 503 for twenty-five minutes with no prior warning.
 */
describe('memoryUsageRatio', () => {
  it('reports used_memory over maxmemory', async () => {
    const { client, calls } = stubClient({
      info: infoMemoryReply(2_362_232_012, 2_684_354_560),
    })
    const maintenance = createQueueMaintenance({ client })

    const ratio = await maintenance.memoryUsageRatio()

    expect(ratio).toBeCloseTo(0.88, 2)
    // `INFO memory`, not `CONFIG GET maxmemory`: one round trip, and `CONFIG`
    // is the command a managed provider is most likely to have revoked.
    expect(calls).toEqual([['INFO', 'memory']])
  })

  it('is null for an instance with no maxmemory, not zero', async () => {
    const { client } = stubClient({ info: infoMemoryReply(2_362_232_012, 0) })
    const maintenance = createQueueMaintenance({ client })

    // Zero is the healthiest reading this gauge has, and an unlimited instance
    // is the configuration where filling up is worst — reporting one as the
    // other is the failure this null exists to prevent.
    expect(await maintenance.memoryUsageRatio()).toBeNull()
  })

  it('is null when the reply carries neither field', async () => {
    const { client } = stubClient({ info: '# Server\r\nredis_version:7.2.5\r\n' })
    const maintenance = createQueueMaintenance({ client })

    expect(await maintenance.memoryUsageRatio()).toBeNull()
  })
})

describe('infoFieldValue', () => {
  it('does not match a field that merely shares a prefix', () => {
    const info = infoMemoryReply(1_000, 4_000)

    // The substring bug this anchoring prevents: a naive search for
    // `used_memory` inside the blob finds `used_memory_human` just as happily,
    // and its value parses to a plausible-looking number.
    expect(infoFieldValue(info, 'used_memory')).toBe(1_000)
    expect(infoFieldValue(info, 'used_memory_rss')).toBe(2_000)
    expect(infoFieldValue(info, 'maxmemory')).toBe(4_000)
  })

  it('is null for a non-numeric value, not NaN', () => {
    expect(infoFieldValue('maxmemory_policy:noeviction\r\n', 'maxmemory_policy')).toBeNull()
  })

  it('is null for a field that is absent', () => {
    expect(infoFieldValue('# Memory\r\nused_memory:5\r\n', 'maxmemory')).toBeNull()
  })
})
