import { loadServiceEnv } from '@openanalytics/domain'
import type { Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import type { AnalyticsGateway } from '../../apps/api/src/gateway-client.ts'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Custom-event counts and saved-funnel results on the key-authenticated read
 * surface, driven through the real app.
 *
 * Both reads already exist behind a dashboard session
 * (`/v1/sites/{site_id}/analytics/custom-events` and `.../funnel`); these tests
 * hold the two properties the read door adds. **Nothing reaches the query
 * gateway — or reads a stored funnel — without the credential, the
 * `analytics:read` scope and the site's own gates**, and **a funnel id only ever
 * resolves on the credential's own site**. The gateway-call log and the funnel
 * lookup log are what prove the "without" half, not the status code alone.
 */

const resolvedKey = {
  value: null as { id: string; siteId: string; type: string; scopes: string[] } | null,
}
const siteBasics = {
  value: null as {
    siteId: string
    slug: string
    name: string
    status: string
    configVersion: number
    publishedImportRunId: string | null
    importCutoverDate: string | null
    reportingCurrency: string
  } | null,
}

interface StoredFunnel {
  id: string
  siteId: string
  name: string
  steps: string[]
  scope: 'visitor' | 'session'
  windowMs: number
  createdByUserId: string | null
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
}

/** Stored funnels keyed `siteId:id`, so a lookup on the wrong site misses. */
const storedFunnels = new Map<string, StoredFunnel>()
const funnelLookups: { id: string; siteId: string }[] = []
const labelLookups: string[] = []

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    resolveReadApiKey: async () => resolvedKey.value,
    getSiteBasics: async () => siteBasics.value,
    touchApiKeyUsage: async () => ({ touched: true }),
    readCostSpent: async () => 0,
    chargeReadCost: async () => undefined,
    getFunnel: async (_db: unknown, input: { id: string; siteId: string }) => {
      funnelLookups.push({ id: input.id, siteId: input.siteId })
      return storedFunnels.get(`${input.siteId}:${input.id}`) ?? null
    },
    listEventDisplayNames: async (_db: unknown, siteId: string) => {
      labelLookups.push(siteId)
      return [{ eventName: 'buy_click', displayName: 'Buy click', displayTemplate: null }]
    },
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')
const { AnalyticsService } = await import('../../apps/api/src/analytics/service.ts')
const { MCP_TOOLS, buildToolRequest, inputSchema } = await import('../../apps/api/src/http/mcp.ts')

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const OTHER_SITE = '9b1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f'
const FUNNEL = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const KEY = 'oa_sk_ZmFrZS10ZXN0LWtleQ'
const WEEK = 'from=2026-07-16T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC'

interface GatewayCall {
  operation: string
  params: Record<string, unknown>
  options: Record<string, unknown>
}
let gatewayCalls: GatewayCall[] = []

const isCustomEventReport = (operation: string) =>
  operation === 'analytics.custom_events_hour' || operation === 'analytics.custom_events_day'

function buildApp() {
  gatewayCalls = []
  const gateway: AnalyticsGateway = {
    query: <TRow = Record<string, unknown>>(
      operation: string,
      params?: unknown,
      queryOptions?: unknown,
    ) => {
      gatewayCalls.push({
        operation,
        params: (params ?? {}) as Record<string, unknown>,
        options: (queryOptions ?? {}) as Record<string, unknown>,
      })
      let rows: Record<string, unknown>[] = []
      if (operation === 'analytics.freshness') {
        rows = [{ watermark: '2026-07-23 14:35:00.000', buckets: '5' }]
      } else if (isCustomEventReport(operation)) {
        rows = [
          {
            event_name: 'buy_click',
            event_type: 'custom',
            events: '45',
            billable_events: '45',
            visitors: '40',
          },
          {
            event_name: 'view_skill',
            event_type: 'custom',
            events: '120',
            billable_events: '120',
            visitors: '90',
          },
        ]
      } else if (operation.startsWith('analytics.custom_event_samples_')) {
        // The newest single event of that name — what the dashboard shows beside
        // the count, and what this surface must not pass on.
        rows = [
          {
            event_name: 'buy_click',
            event_type: 'custom',
            last_seen_at: '2026-07-22 09:15:00.000',
            sample_page_path: '/skills/some-skill',
            sample_properties: '{"plan":"pro"}',
          },
        ]
      } else if (
        operation === 'analytics.funnel_visitor' ||
        operation === 'analytics.funnel_session'
      ) {
        rows = [{ step_1: '45', step_2: '45', step_3: '4' }]
      }
      return Promise.resolve({
        operation,
        rows: rows as unknown as readonly TRow[],
        meta: { row_count: rows.length, truncated: false, elapsed_ms: 1, cached: false },
      })
    },
  }
  const { logger } = createCapturedLogger()
  return createApp({
    service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
    logger,
    env: loadServiceEnv('api', { ...testEnv(), COLLECTOR_BASE_URL: 'https://c.test' }),
    db: {} as Database,
    analytics: new AnalyticsService(gateway),
  })
}

const get = (path: string, app = buildApp()) =>
  app.fetch(new Request(`http://api.test${path}`, { headers: { authorization: `Bearer ${KEY}` } }))

const activeSite = () => ({
  siteId: SITE,
  slug: 's',
  name: 'S',
  status: 'active',
  configVersion: 3,
  publishedImportRunId: null,
  importCutoverDate: null,
  reportingCurrency: 'USD',
})

const readingKey = () => ({
  id: 'key-1',
  siteId: SITE,
  type: 'private_read',
  scopes: ['site:read', 'analytics:read'],
})

const checkoutFunnel = (overrides: Partial<StoredFunnel> = {}): StoredFunnel => ({
  id: FUNNEL,
  siteId: SITE,
  name: 'Skill checkout',
  steps: ['view_skill', 'buy_click', 'begin_checkout'],
  scope: 'visitor',
  windowMs: 3_600_000,
  createdByUserId: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-02T00:00:00.000Z'),
  archivedAt: null,
  ...overrides,
})

interface CustomEventItem {
  event_name: string
  events: number
  visitors: number
  display_name: string | null
}

beforeEach(() => {
  resolvedKey.value = null
  siteBasics.value = null
  storedFunnels.clear()
  funnelLookups.length = 0
  labelLookups.length = 0
})

describe('GET /v1/read/analytics/custom-events', () => {
  it('403s a key without analytics:read, before the gateway and before any label lookup', async () => {
    resolvedKey.value = { ...readingKey(), scopes: ['site:read'] }
    siteBasics.value = activeSite()
    const app = buildApp()
    const res = await get(`/v1/read/analytics/custom-events?${WEEK}`, app)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN')
    expect(gatewayCalls).toHaveLength(0)
    expect(labelLookups).toHaveLength(0)
  })

  it('serves events and visitors per event name, labelled as the dashboard labels them', async () => {
    resolvedKey.value = readingKey()
    siteBasics.value = activeSite()
    const app = buildApp()
    const res = await get(`/v1/read/analytics/custom-events?${WEEK}`, app)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: CustomEventItem[]; days?: unknown }

    const byName = new Map(body.items.map((item) => [item.event_name, item]))
    expect(byName.get('buy_click')).toMatchObject({
      events: 45,
      visitors: 40,
      display_name: 'Buy click',
    })
    // An event with no dashboard definition says so with `null`, not absence.
    expect(byName.get('view_skill')).toMatchObject({ events: 120, display_name: null })
    // Totals only, unless a breakdown was asked for.
    expect(body.days).toBeUndefined()
    // The aggregate and nothing about any single event: the gateway handed back
    // a sample for buy_click, and this surface does not pass it on.
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual([
        'billable_events',
        'display_name',
        'display_template',
        'event_name',
        'event_type',
        'events',
        'visitors',
      ])
    }

    const reports = gatewayCalls.filter((call) => isCustomEventReport(call.operation))
    expect(reports).toHaveLength(1)
    expect(reports[0]?.params['site_id']).toBe(SITE)
    expect(reports[0]?.options['cacheEpoch']).toBe(3)
    expect(labelLookups).toEqual([SITE])
  })

  it('adds one labelled row set per UTC day with breakdown=day', async () => {
    resolvedKey.value = readingKey()
    siteBasics.value = activeSite()
    const app = buildApp()
    const res = await get(`/v1/read/analytics/custom-events?${WEEK}&breakdown=day`, app)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: CustomEventItem[]
      days: { date: string; from: string; to: string; items: CustomEventItem[] }[]
    }

    expect(body.days.map((day) => day.date)).toEqual([
      '2026-07-16',
      '2026-07-17',
      '2026-07-18',
      '2026-07-19',
      '2026-07-20',
      '2026-07-21',
      '2026-07-22',
    ])
    expect(body.days[0]).toMatchObject({
      from: '2026-07-16T00:00:00.000Z',
      to: '2026-07-17T00:00:00.000Z',
    })
    expect(body.days[6]?.to).toBe('2026-07-23T00:00:00.000Z')
    for (const day of body.days) {
      expect(day.items.find((item) => item.event_name === 'buy_click')?.display_name).toBe(
        'Buy click',
      )
    }

    // The same report operation the dashboard uses, once for the totals and
    // once per day — each day is the dashboard's own number for that day.
    const reports = gatewayCalls.filter((call) => isCustomEventReport(call.operation))
    expect(reports).toHaveLength(1 + 7)
    const dayRanges = reports.map(
      (call) => `${String(call.params['from'])}..${String(call.params['to'])}`,
    )
    expect(dayRanges).toContain('2026-07-18T00:00:00.000Z..2026-07-19T00:00:00.000Z')
  })

  it('cuts days at local midnight in the requested timezone', async () => {
    resolvedKey.value = readingKey()
    siteBasics.value = activeSite()
    const range =
      'from=2026-07-15T16:00:00.000Z&to=2026-07-17T16:00:00.000Z&timezone=Asia%2FShanghai'
    const res = await get(`/v1/read/analytics/custom-events?${range}&breakdown=day`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { days: { date: string; from: string; to: string }[] }
    expect(body.days.map(({ date, from, to }) => ({ date, from, to }))).toEqual([
      { date: '2026-07-16', from: '2026-07-15T16:00:00.000Z', to: '2026-07-16T16:00:00.000Z' },
      { date: '2026-07-17', from: '2026-07-16T16:00:00.000Z', to: '2026-07-17T16:00:00.000Z' },
    ])
  })

  it('refuses a daily breakdown wider than 31 days, before the gateway', async () => {
    resolvedKey.value = readingKey()
    siteBasics.value = activeSite()
    const app = buildApp()
    const range = 'from=2026-06-01T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC'
    const res = await get(`/v1/read/analytics/custom-events?${range}&breakdown=day`, app)
    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: { code: string; details: { max_days: number } }
    }
    expect(body.error.code).toBe('RANGE_TOO_LARGE')
    expect(body.error.details.max_days).toBe(31)
    expect(gatewayCalls).toHaveLength(0)
  })

  it('refuses a breakdown it does not have, by name', async () => {
    resolvedKey.value = readingKey()
    siteBasics.value = activeSite()
    const app = buildApp()
    const res = await get(`/v1/read/analytics/custom-events?${WEEK}&breakdown=week`, app)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED')
    expect(gatewayCalls).toHaveLength(0)
  })
})

describe('GET /v1/read/analytics/funnels/{funnel_id}', () => {
  it('403s a key without analytics:read, before the funnel is even looked up', async () => {
    resolvedKey.value = { ...readingKey(), scopes: ['site:read'] }
    siteBasics.value = activeSite()
    storedFunnels.set(`${SITE}:${FUNNEL}`, checkoutFunnel())
    const app = buildApp()
    const res = await get(`/v1/read/analytics/funnels/${FUNNEL}?${WEEK}`, app)
    expect(res.status).toBe(403)
    expect(funnelLookups).toHaveLength(0)
    expect(gatewayCalls).toHaveLength(0)
  })

  it('runs the stored definition and returns how many reached each step', async () => {
    resolvedKey.value = readingKey()
    siteBasics.value = activeSite()
    storedFunnels.set(`${SITE}:${FUNNEL}`, checkoutFunnel())
    const app = buildApp()
    const res = await get(`/v1/read/analytics/funnels/${FUNNEL}?${WEEK}`, app)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      funnel: Record<string, unknown>
      meta: { scope: string; window_ms: number }
      steps: { step: number; key: string; count: number; conversion_rate: number }[]
    }

    expect(body.funnel).toEqual({
      id: FUNNEL,
      name: 'Skill checkout',
      steps: ['view_skill', 'buy_click', 'begin_checkout'],
      scope: 'visitor',
      window_ms: 3_600_000,
      created_by_user_id: null,
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-02T00:00:00.000Z',
      archived_at: null,
    })
    expect(body.steps.map(({ key, count }) => ({ key, count }))).toEqual([
      { key: 'view_skill', count: 45 },
      { key: 'buy_click', count: 45 },
      { key: 'begin_checkout', count: 4 },
    ])
    expect(body.steps[2]?.conversion_rate).toBeCloseTo(4 / 45)
    expect(body.meta).toMatchObject({ scope: 'visitor', window_ms: 3_600_000 })

    // The funnel was looked up on the key's own site, and the gateway ran the
    // stored steps, scope and window — nothing from the caller but the range.
    expect(funnelLookups).toEqual([{ id: FUNNEL, siteId: SITE }])
    const run = gatewayCalls.find((call) => call.operation === 'analytics.funnel_visitor')
    expect(run?.params).toMatchObject({
      site_id: SITE,
      steps: ['view_skill', 'buy_click', 'begin_checkout'],
      window_ms: 3_600_000,
    })
    expect(run?.options['cacheEpoch']).toBe(3)
  })

  it('runs a session-scoped funnel through the session operation', async () => {
    resolvedKey.value = readingKey()
    siteBasics.value = activeSite()
    storedFunnels.set(`${SITE}:${FUNNEL}`, checkoutFunnel({ scope: 'session' }))
    const app = buildApp()
    const res = await get(`/v1/read/analytics/funnels/${FUNNEL}?${WEEK}`, app)
    expect(res.status).toBe(200)
    expect(gatewayCalls.map((call) => call.operation)).toContain('analytics.funnel_session')
    expect(gatewayCalls.map((call) => call.operation)).not.toContain('analytics.funnel_visitor')
  })

  it('404s a funnel that belongs to another site, without querying the gateway', async () => {
    resolvedKey.value = readingKey()
    siteBasics.value = activeSite()
    storedFunnels.set(`${OTHER_SITE}:${FUNNEL}`, checkoutFunnel({ siteId: OTHER_SITE }))
    const app = buildApp()
    const res = await get(`/v1/read/analytics/funnels/${FUNNEL}?${WEEK}`, app)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND')
    expect(funnelLookups).toEqual([{ id: FUNNEL, siteId: SITE }])
    expect(gatewayCalls).toHaveLength(0)
  })

  it('404s an id that is not a uuid, without a database lookup', async () => {
    resolvedKey.value = readingKey()
    siteBasics.value = activeSite()
    const app = buildApp()
    const res = await get(`/v1/read/analytics/funnels/not-a-funnel?${WEEK}`, app)
    expect(res.status).toBe(404)
    expect(funnelLookups).toHaveLength(0)
    expect(gatewayCalls).toHaveLength(0)
  })
})

describe('the MCP tools for these reads', () => {
  const tool = (name: string) => {
    const found = MCP_TOOLS.find((candidate) => candidate.name === name)
    if (!found) throw new Error(`no tool named ${name}`)
    return found
  }
  const credential = { header: 'authorization' as const, value: 'Bearer token' }

  it('custom_events reads the custom-events route and forwards the breakdown', () => {
    const request = buildToolRequest({
      tool: tool('custom_events'),
      args: {
        site_id: SITE,
        from: '2026-07-16T00:00:00.000Z',
        to: '2026-07-23T00:00:00.000Z',
        breakdown: 'day',
      },
      resourceUrl: 'https://api.test',
      credential,
    })
    const url = new URL(request.url)
    expect(url.pathname).toBe('/v1/read/analytics/custom-events')
    expect(url.searchParams.get('breakdown')).toBe('day')
    expect(url.searchParams.get('timezone')).toBe('UTC')
    expect(request.headers.get('X-OA-Site')).toBe(SITE)
    expect(tool('custom_events').annotations?.readOnlyHint ?? true).toBe(true)
  })

  it('funnel_report needs a funnel id and a site, and reads that funnel on that site', () => {
    const schema = inputSchema(tool('funnel_report')) as { required: string[] }
    expect(schema.required).toEqual(expect.arrayContaining(['funnel_id', 'site_id', 'from', 'to']))

    const request = buildToolRequest({
      tool: tool('funnel_report'),
      args: {
        site_id: SITE,
        funnel_id: FUNNEL,
        from: '2026-07-16T00:00:00.000Z',
        to: '2026-07-23T00:00:00.000Z',
      },
      resourceUrl: 'https://api.test',
      credential,
    })
    const url = new URL(request.url)
    expect(request.method).toBe('GET')
    expect(url.pathname).toBe(`/v1/read/analytics/funnels/${FUNNEL}`)
    expect(request.headers.get('X-OA-Site')).toBe(SITE)
  })
})
