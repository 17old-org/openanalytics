import { loadPolicy } from '@openanalytics/domain'
import { createRecordingMetrics } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'
import { createIngestLoop } from '../../apps/worker/src/ingest/index.ts'
import type { IngestDeps } from '../../apps/worker/src/ingest/index.ts'

/**
 * The worker's half of the queue memory guard: the loop that already reads the
 * ratio for the capacity gauge is the one that acts on it, so a filling queue
 * is relieved within seconds rather than at the next hourly retention trim.
 */

interface TrimCall {
  now: Date
  targetRatio: number
  floorMs: number
}

function noopDb(): IngestDeps['db'] {
  const readChain: Record<string, unknown> = {}
  for (const method of ['from', 'where', 'orderBy', 'limit']) {
    readChain[method] = () => readChain
  }
  readChain['then'] = (resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve([]))
  return {
    select: () => readChain,
    insert: () => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) }),
  } as unknown as IngestDeps['db']
}

function buildDeps(ratio: number | null) {
  const { logger, lines } = createCapturedLogger()
  const metrics = createRecordingMetrics()
  const trims: TrimCall[] = []
  let ms = Date.parse('2026-11-01T07:00:00.000Z')
  const deps = {
    consumer: {
      ensureGroup: () => Promise.resolve(true),
      read: () => Promise.resolve([]),
      reclaim: () => Promise.resolve({ nextCursor: '0-0', messages: [], deletedIds: [] }),
      ack: () => Promise.resolve(0),
      pending: () => Promise.resolve({ count: 0, minId: null, maxId: null, consumers: [] }),
      fetchByIds: () => Promise.resolve({ messages: [], missingIds: [] }),
    },
    maintenance: {
      publishDeadLetter: () => Promise.resolve(0),
      trimAcked: () => Promise.resolve({ trimmed: 0, minId: '0-0' }),
      oldestPendingAgeMs: () => Promise.resolve(null),
      memoryUsageRatio: () => Promise.resolve(ratio),
      trimForMemory: (input: TrimCall) => {
        trims.push(input)
        return Promise.resolve({
          trimmed: 1234,
          ratioBefore: ratio,
          ratioAfter: 0.55,
          minId: '1-0',
        })
      },
    },
    clickhouse: {
      insertEvents: () => Promise.reject(new Error('unused')),
      countBillableByBatch: () => Promise.resolve(new Map()),
      ping: () => Promise.resolve(true),
      close: () => Promise.resolve(),
    },
    cache: null,
    db: noopDb(),
    logger,
    metrics,
    policy: loadPolicy({}),
    consumerName: 'test-worker',
    streamName: 'event_stream',
    consumerGroup: 'ingest_workers',
    now: () => new Date(ms),
  } as unknown as IngestDeps
  return { deps, trims, lines, metrics, advance: (delta: number) => (ms += delta) }
}

describe('ingest loop queue memory guard', () => {
  it('trims for memory when the ratio is above the policy target', async () => {
    const { deps, trims, lines, metrics } = buildDeps(0.97)

    await createIngestLoop({ deps, recoveryLimit: 1 }).tick()

    expect(trims).toEqual([
      { now: new Date('2026-11-01T07:00:00.000Z'), targetRatio: 0.6, floorMs: 3_600_000 },
    ])
    expect(metrics.countOf('worker_queue_trimmed')).toBe(1234)
    expect(metrics.recorded.find((m) => m.name === 'worker_queue_trimmed')?.labels).toEqual({
      reason: 'memory',
    })
    const warning = lines.find((line) => line['msg'] === 'queue_memory_pressure_trimmed')
    expect(warning).toMatchObject({ trimmed: 1234, ratio_before: 0.97, ratio_after: 0.55 })
  })

  it('leaves the queue alone at or below the target', async () => {
    const { deps, trims } = buildDeps(0.6)

    await createIngestLoop({ deps, recoveryLimit: 1 }).tick()

    expect(trims).toEqual([])
  })

  it('leaves an instance without maxmemory alone', async () => {
    const { deps, trims } = buildDeps(null)

    await createIngestLoop({ deps, recoveryLimit: 1 }).tick()

    expect(trims).toEqual([])
  })

  it('trims at most once every 30 seconds', async () => {
    const { deps, trims, advance } = buildDeps(0.97)
    const loop = createIngestLoop({ deps, recoveryLimit: 1 })

    await loop.tick()
    advance(10_000)
    await loop.tick()
    expect(trims).toHaveLength(1)

    advance(25_000)
    await loop.tick()
    expect(trims).toHaveLength(2)
  })

  it('survives a trim that fails', async () => {
    const { deps, lines } = buildDeps(0.97)
    ;(deps.maintenance as unknown as { trimForMemory: () => Promise<never> }).trimForMemory = () =>
      Promise.reject(new Error('READONLY'))

    await expect(createIngestLoop({ deps, recoveryLimit: 1 }).tick()).resolves.toBeUndefined()
    expect(lines.some((line) => line['msg'] === 'queue_memory_trim_failed')).toBe(true)
  })
})
