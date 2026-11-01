import type { DependencyHealth } from '@openanalytics/contracts'
import type { HealthCheck } from '@openanalytics/observability/hono'
import { infoFieldValue } from '@openanalytics/redis'

/**
 * The event queue as a `/health` dependency.
 *
 * Every 202 the collector answers depends on a queue write, so a queue that
 * cannot take one is the collector being down, whatever the process says. On
 * 2026-11-01 the queue sat at 100 % of `maxmemory` for hours, `noeviction`
 * refused every event, and `/health` answered `ok` throughout because it
 * checked nothing.
 *
 * `degraded` from this fraction of `maxmemory`: early enough that the warning
 * arrives before writes fail, and above the worker's own trim target, so a
 * reading here means the worker's memory guard is not keeping up.
 */
const DEGRADED_MEMORY_RATIO = 0.9

/** The one command surface the check needs, so any queue client satisfies it. */
export interface QueueHealthClient {
  call(command: string, ...args: string[]): Promise<unknown>
}

export function createQueueHealthCheck(options: {
  readonly client: QueueHealthClient
}): HealthCheck {
  const name = 'event_queue'
  return {
    name,
    async check(): Promise<DependencyHealth> {
      let info: string
      try {
        await options.client.call('PING')
        info = String((await options.client.call('INFO', 'memory')) ?? '')
      } catch {
        // Coarse on purpose: the response is unauthenticated, and a driver
        // error carries the host and port.
        return { name, status: 'unavailable', detail: 'unreachable' }
      }

      const used = infoFieldValue(info, 'used_memory')
      const max = infoFieldValue(info, 'maxmemory')
      if (used !== null && max !== null && max > 0 && used / max >= DEGRADED_MEMORY_RATIO) {
        return { name, status: 'degraded', detail: `memory ${Math.round((used / max) * 100)}%` }
      }
      return { name, status: 'ok', detail: null }
    },
  }
}
