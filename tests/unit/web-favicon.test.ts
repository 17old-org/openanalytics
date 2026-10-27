import { afterEach, expect, it, vi } from 'vitest'

// The Next app has its own TypeScript project/module mode. Load the route at
// runtime so the backend test project's compiler does not reclassify it as CJS.
const routePath = '../../apps/web/app/api/favicon/route.ts'
const { GET } = (await import(routePath)) as {
  GET: (request: Request) => Promise<Response>
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const request = (domain: string) =>
  new Request(`https://app.example.com/api/favicon?domain=${encodeURIComponent(domain)}`)

it('uses the configured official favicon instead of a stale provider copy', async () => {
  vi.stubEnv(
    'FAVICON_OVERRIDES',
    JSON.stringify({
      'bizpeel.com': 'https://bizpeel.com/apple-touch-icon.png',
    }),
  )
  const fetcher = vi.fn().mockResolvedValue(
    new Response('new logo', {
      headers: { 'content-type': 'image/png' },
    }),
  )
  vi.stubGlobal('fetch', fetcher)
  const response = await GET(request('bizpeel.com'))
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://bizpeel.com/apple-touch-icon.png')
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' })
  expect(await response.text()).toBe('new logo')
  expect(response.headers.get('content-type')).toBe('image/png')
})

it('preserves provider lookup for sites without an override', async () => {
  vi.stubEnv('FAVICON_OVERRIDES', '{}')
  const fetcher = vi.fn().mockResolvedValue(
    new Response('logo', {
      headers: { 'content-type': 'image/png' },
    }),
  )
  vi.stubGlobal('fetch', fetcher)
  expect((await GET(request('example.com'))).status).toBe(200)
  expect(fetcher.mock.calls[0]?.[0]).toContain('https://t2.gstatic.com/faviconV2?')
})

it('does not let a request supply an arbitrary URL', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  expect((await GET(request('https://127.0.0.1/private'))).status).toBe(400)
  expect(fetcher).not.toHaveBeenCalled()
})

it('returns a bodyless miss when the override redirects or fails', async () => {
  vi.stubEnv('FAVICON_OVERRIDES', '{"bizpeel.com":"https://bizpeel.com/apple-touch-icon.png"}')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('redirect')))
  const response = await GET(request('bizpeel.com'))
  expect(response.status).toBe(404)
  expect(await response.text()).toBe('')
})
