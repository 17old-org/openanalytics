import { describe, expect, it } from 'vitest'
import { createQueueHealthCheck } from '../../apps/collector/src/queue-health.ts'

/**
 * The collector's `/health` said `ok` for the whole of the 2026-11-01 outage,
 * because it checked nothing: the queue was full, every event was refused with
 * 503, and the one endpoint an operator would look at reported a healthy
 * service. The event queue is now a dependency it reports.
 */

type Client = Parameters<typeof createQueueHealthCheck>[0]['client']

function client(replies: { ping?: unknown; info?: unknown; fail?: boolean }): Client {
  return {
    call: (...args: unknown[]) => {
      if (replies.fail) return Promise.reject(new Error('connect ECONNREFUSED 10.0.0.7:6379'))
      const command = String(args[0])
      if (command === 'PING') return Promise.resolve(replies.ping ?? 'PONG')
      if (command === 'INFO') return Promise.resolve(replies.info ?? '')
      return Promise.reject(new Error(`unexpected ${command}`))
    },
  } as unknown as Client
}

function info(used: number, max: number): string {
  return ['# Memory', `used_memory:${used}`, `maxmemory:${max}`, ''].join('\r\n')
}

describe('collector queue health check', () => {
  it('is ok while the queue has room', async () => {
    const check = createQueueHealthCheck({ client: client({ info: info(500, 1000) }) })
    expect(await check.check()).toEqual({ name: 'event_queue', status: 'ok', detail: null })
  })

  it('is degraded from 90 % of maxmemory, before writes start failing', async () => {
    const check = createQueueHealthCheck({ client: client({ info: info(950, 1000) }) })
    expect(await check.check()).toEqual({
      name: 'event_queue',
      status: 'degraded',
      detail: 'memory 95%',
    })
  })

  it('is ok on an instance without maxmemory', async () => {
    const check = createQueueHealthCheck({ client: client({ info: info(950, 0) }) })
    expect((await check.check()).status).toBe('ok')
  })

  it('is unavailable when the queue cannot be reached, without leaking the address', async () => {
    const check = createQueueHealthCheck({ client: client({ fail: true }) })
    const result = await check.check()
    expect(result).toEqual({ name: 'event_queue', status: 'unavailable', detail: 'unreachable' })
  })
})
