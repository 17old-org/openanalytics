import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SITE_GONE_TTL_MS } from '../../apps/tracker/src/config.ts'
import { resetBrowser } from './harness.ts'

/**
 * The boot path of a page whose site is gone (ADR-0074).
 *
 * Separate from `boot.test.ts` deliberately: that file's `afterEach` asserts a
 * tracker was installed, and the whole claim under test here is that nothing
 * was. Same shape otherwise — a real `<script>` tag, stubbed browser
 * capabilities, the entry module imported so its top-level `boot()` runs.
 */

const TRACKING_KEY = 'oa_pub_live_abcdef123456'
const COLLECTOR_URL = 'https://collect.example.com'
const CONFIG_KEY = 'oa.config'

let sent: { url: string }[] = []

const originalFetch = globalThis.fetch
const originalSendBeacon = globalThis.navigator.sendBeacon

function stubCapabilities(): void {
  const globals = globalThis as unknown as Record<string, unknown>
  globals['fetch'] = (url: string) => {
    sent.push({ url })
    if (url.includes('/v1/tracker/config')) {
      return Promise.resolve(
        new Response(JSON.stringify({ config_version: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json', etag: '"cfg-1"' },
        }),
      )
    }
    return Promise.resolve(new Response(null, { status: 202 }))
  }
  ;(globalThis.navigator as unknown as Record<string, unknown>)['sendBeacon'] = (url: string) => {
    sent.push({ url })
    return true
  }
}

async function boot(): Promise<void> {
  const script = document.createElement('script')
  script.setAttribute('data-key', TRACKING_KEY)
  script.setAttribute('data-collector', COLLECTOR_URL)
  document.head.appendChild(script)

  vi.resetModules()
  await import('../../apps/tracker/src/browser.ts')
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const goneMarker = (at: number): string => JSON.stringify({ etag: null, at, body: {}, gone: true })

beforeEach(() => {
  resetBrowser()
  sent = []
  stubCapabilities()
})

afterEach(() => {
  const globals = globalThis as unknown as Record<string, unknown>
  const tracker = globals['oa'] as { stop(): void } | undefined
  tracker?.stop()
  delete globals['oa']
  for (const node of Array.from(document.head.querySelectorAll('script'))) node.remove()
  resetBrowser()
  globals['fetch'] = originalFetch
  ;(globalThis.navigator as unknown as Record<string, unknown>)['sendBeacon'] = originalSendBeacon
})

describe('boot on a gone site (ADR-0074)', () => {
  it('a fresh marker installs nothing and makes no request of any kind', async () => {
    window.localStorage.setItem(CONFIG_KEY, goneMarker(Date.now()))

    await boot()
    await settle()

    expect(sent).toEqual([])
    expect((globalThis as unknown as Record<string, unknown>)['oa']).toBeUndefined()
  })

  it('a stale marker boots normally, re-probes and resumes on a healthy answer', async () => {
    window.localStorage.setItem(CONFIG_KEY, goneMarker(Date.now() - SITE_GONE_TTL_MS - 1))

    await boot()
    await settle()

    expect(sent.filter((request) => request.url.includes('/v1/tracker/config')).length).toBe(1)
    expect(sent.filter((request) => request.url.endsWith('/v1/events')).length).toBe(1)
    expect((globalThis as unknown as Record<string, unknown>)['oa']).toBeTypeOf('object')
  })
})
