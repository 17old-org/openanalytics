import { createPolarRevenueAdapter, POLAR_API_BASE } from '@openanalytics/integrations'
import { signStandardWebhook } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'
import {
  polarCheckout,
  polarEvent,
  polarHeaders,
  polarListPage,
  polarOrder,
  polarRefund,
} from '../support/revenue-fixtures.ts'

/**
 * The Polar revenue adapter's semantics (ADR-0033, D1/D4/D5; D-P1…D-P8).
 *
 * The twin of the Stripe suite, and it proves the same three things plus the
 * ones that only exist because Polar is a *different* provider:
 *
 * 1. **The consumed allowlist is D-P2's**, and everything outside it is
 *    `ignored` with a category rather than an error — an organization's whole
 *    event stream reaches a broadly-subscribed endpoint, and a 4xx for a type we
 *    correctly do not read would show the customer a permanently failing
 *    webhook.
 * 2. **Amounts are integer passthrough**, and the amount is `net_amount` — after
 *    discounts, before the tax Polar remits as merchant of record.
 * 3. **The event id comes from the `webhook-id` header**, because Polar's
 *    envelope carries none. This is the property `revenue_provider_events`
 *    dedupes on and the reason the port passes a header set at all.
 * 4. **The walk is oldest-first**, which is ADR-0033 D4 as written — the thing
 *    Stripe's adapter had to record a deviation from.
 */

const adapter = createPolarRevenueAdapter()
const HEADERS = polarHeaders()

/** Normalize with the delivery context a real webhook would carry. */
function normalizeOne(event: Record<string, unknown>, headers = HEADERS) {
  const outcome = adapter.normalizeEvent(event, { headers })
  if (!outcome.ok) throw new Error(`normalize failed: ${outcome.reason}`)
  return outcome.event
}

describe('normalizeEvent — orders become charges', () => {
  it('reads order.paid into the canonical snapshot', () => {
    const event = normalizeOne(polarEvent('order.paid', polarOrder()))
    expect(event.eventType).toBe('order.paid')
    expect(event.observations).toHaveLength(1)
    const [observation] = event.observations
    expect(observation?.objectId).toBe('ord_test_1')
    expect(observation?.objectKind).toBe('charge')
    expect(observation?.normalized).toMatchObject({
      object_kind: 'charge',
      status: 'paid',
      currency: 'usd',
      // `net_amount` (4999), NOT `total_amount` (5499). The difference is the
      // tax Polar collects and remits — money the seller never receives.
      gross_minor: 4999,
      net_minor: 4999,
      order_id: 'ord_test_1',
      checkout_session_id: 'chk_test_1',
      customer_id: 'cust_test_1',
      product_id: 'prod_test_1',
      product_name: 'Pro plan',
      parent_object_id: '',
    })
  })

  it('takes the event id from the HEADER, because the body has none', () => {
    // Polar's envelope is `{type, timestamp, data}`. Without the header there is
    // no ledger key, so this is the whole reason the port carries headers.
    const event = normalizeOne(
      polarEvent('order.paid', polarOrder()),
      polarHeaders({ 'webhook-id': 'whid_from_header' }),
    )
    expect(event.eventId).toBe('whid_from_header')
  })

  it('refuses a delivery with no webhook-id rather than inventing one', () => {
    // A fabricated id would create a ledger row no redelivery could ever match,
    // which is worse than refusing: the dedupe would silently stop working.
    const outcome = adapter.normalizeEvent(polarEvent('order.paid', polarOrder()), { headers: {} })
    expect(outcome).toEqual({ ok: false, reason: 'malformed_event' })

    expect(adapter.normalizeEvent(polarEvent('order.paid', polarOrder()))).toEqual({
      ok: false,
      reason: 'malformed_event',
    })
  })

  it('uses the EVENT timestamp as the snapshot time, not the order created_at', () => {
    const event = normalizeOne(
      polarEvent('order.paid', polarOrder({ created_at: '2026-07-31T10:00:00.000Z' }), {
        timestamp: '2026-07-31T12:00:00.000Z',
      }),
    )
    expect(event.observations[0]?.snapshotAt.toISOString()).toBe('2026-07-31T12:00:00.000Z')
    // …while `occurred_at` — the bucket the money lands in — stays the order's.
    expect(event.observations[0]?.normalized.occurred_at).toBe('2026-07-31T10:00:00.000Z')
  })

  it('maps order.refunded to the CHARGE, because the payload is an Order', () => {
    // D-P2 wrote this as a refund object. It cannot be: `revenue_objects` is
    // unique on `(site_id, provider, object_id)` with `object_kind` OUTSIDE the
    // key, so a refund carrying the order's id would collide with the charge
    // head for that same order. Mirrors Stripe's `charge.refunded`.
    const event = normalizeOne(
      polarEvent(
        'order.refunded',
        polarOrder({ status: 'refunded', refunded_amount: 4999, refunded_tax_amount: 500 }),
      ),
    )
    expect(event.observations[0]?.objectKind).toBe('charge')
    expect(event.observations[0]?.objectId).toBe('ord_test_1')
    expect(event.observations[0]?.normalized).toMatchObject({
      status: 'refunded',
      // The charge keeps its full gross: D2d puts the refund's amount in the
      // refund's own bucket, never against the charge.
      gross_minor: 4999,
    })
  })

  it('promotes a paid order carrying a refund its status has not caught up with', () => {
    const partial = normalizeOne(
      polarEvent('order.updated', polarOrder({ status: 'paid', refunded_amount: 1500 })),
    )
    expect(partial.observations[0]?.normalized.status).toBe('partially_refunded')

    const full = normalizeOne(
      polarEvent('order.updated', polarOrder({ status: 'paid', refunded_amount: 4999 })),
    )
    expect(full.observations[0]?.normalized.status).toBe('refunded')
  })

  it('treats an UNPAID order event as understood-but-carrying-no-money', () => {
    for (const status of ['draft', 'pending', 'void']) {
      const outcome = adapter.normalizeEvent(
        polarEvent('order.created', polarOrder({ status, paid: false })),
        { headers: HEADERS },
      )
      expect(outcome.ok && outcome.event.observations).toHaveLength(0)
      expect(outcome.ok && outcome.event.ignored).toBe('no_observations')
    }
  })

  it('reads a flat id reference as well as an expanded object', () => {
    // Which form arrives has moved between Polar API versions, and reading only
    // one is the bug that made every invoice.paid ignored in production.
    const expanded = normalizeOne(
      polarEvent(
        'order.paid',
        polarOrder({ customer_id: null, customer: { id: 'cust_expanded', external_id: 'u1' } }),
      ),
    )
    expect(expanded.observations[0]?.normalized.customer_id).toBe('cust_expanded')

    const flat = normalizeOne(
      polarEvent('order.paid', polarOrder({ customer_id: 'cust_flat', customer: null })),
    )
    expect(flat.observations[0]?.normalized.customer_id).toBe('cust_flat')
  })
})

describe('normalizeEvent — refunds', () => {
  it('reads refund.created with its parent order', () => {
    const event = normalizeOne(polarEvent('refund.created', polarRefund()))
    const [observation] = event.observations
    expect(observation?.objectId).toBe('ref_test_1')
    expect(observation?.objectKind).toBe('refund')
    expect(observation?.normalized).toMatchObject({
      object_kind: 'refund',
      status: 'succeeded',
      currency: 'usd',
      // The refund's own `amount`, with its `tax_amount` (150) excluded —
      // symmetric with the order reading `net_amount`, so a full refund nets to
      // zero against the charge instead of over-crediting by remitted tax.
      gross_minor: 1500,
      // The charge head for a Polar order is keyed on the order id, so the
      // parent link resolves directly.
      parent_object_id: 'ord_test_1',
      order_id: 'ord_test_1',
    })
  })

  it('passes Polar’s refund status through, because its four are already D5’s', () => {
    for (const status of ['succeeded', 'pending', 'failed', 'canceled']) {
      const event = normalizeOne(polarEvent('refund.updated', polarRefund({ status })))
      expect(event.observations[0]?.normalized.status).toBe(status)
    }
  })

  it('leaves a refund fee UNKNOWN rather than claiming it was zero', () => {
    // Polar exposes no fee field on a refund, so whether it reverses its
    // platform fee is unverified. `fee_currency: ''` says "unknown"; a
    // `fee_minor: 0` with a currency would say "this cost nothing".
    const event = normalizeOne(polarEvent('refund.created', polarRefund()))
    expect(event.observations[0]?.normalized).toMatchObject({
      fee_minor: 0,
      fee_currency: '',
      net_minor: 1500,
    })
  })
})

describe('normalizeEvent — the ignore vocabulary', () => {
  it('turns a checkout into a HINT and no observation', () => {
    const event = normalizeOne(polarEvent('checkout.updated', polarCheckout()))
    expect(event.observations).toHaveLength(0)
    expect(event.hints).toHaveLength(1)
    expect(event.hints?.[0]).toMatchObject({
      checkoutSessionId: 'chk_test_1',
      // Always empty for Polar: a checkout does not know the order it will
      // produce. The join runs from the charge's `checkout_session_id` back to
      // this hint, not the other way.
      orderId: '',
      clientReferenceId: 'site_user_1',
      customerId: '',
    })
  })

  it('never reads an email off a checkout', () => {
    const event = normalizeOne(
      polarEvent(
        'checkout.updated',
        polarCheckout({ customer_email: 'someone@example.com', customer_name: 'Someone' }),
      ),
    )
    expect(JSON.stringify(event.hints)).not.toContain('someone@example.com')
  })

  it('acks a checkout with no id as understood-but-empty', () => {
    // The id is the hint's uniqueness key; without it a redelivery would insert
    // a second row rather than update the first.
    const outcome = adapter.normalizeEvent(
      polarEvent('checkout.updated', polarCheckout({ id: null })),
      {
        headers: HEADERS,
      },
    )
    expect(outcome.ok && outcome.event.ignored).toBe('no_observations')
  })

  it('acks subscription context events the same way', () => {
    for (const type of ['subscription.created', 'subscription.canceled', 'subscription.cycled']) {
      const outcome = adapter.normalizeEvent(polarEvent(type, { id: 'sub_1' }), {
        headers: HEADERS,
      })
      expect(outcome.ok && outcome.event.ignored).toBe('no_observations')
    }
  })

  it('separates "we do not read this type" from "this carried no money"', () => {
    const unread = adapter.normalizeEvent(polarEvent('benefit_grant.created', { id: 'b_1' }), {
      headers: HEADERS,
    })
    expect(unread.ok && unread.event.ignored).toBe('unhandled_event_type')

    const empty = adapter.normalizeEvent(polarEvent('subscription.created', { id: 's_1' }), {
      headers: HEADERS,
    })
    expect(empty.ok && empty.event.ignored).toBe('no_observations')
  })

  it('reports an allowlisted event whose object it cannot read', () => {
    const outcome = adapter.normalizeEvent(polarEvent('order.paid', { status: 'paid' }), {
      headers: HEADERS,
    })
    expect(outcome.ok && outcome.event.ignored).toBe('unsupported_object_shape')
  })

  it('refuses a body that is not an event at all', () => {
    for (const body of [null, 'a string', 42, [], { data: {} }, { type: 'order.paid' }]) {
      expect(adapter.normalizeEvent(body, { headers: HEADERS })).toEqual({
        ok: false,
        reason: 'malformed_event',
      })
    }
  })
})

describe('amounts and the three states of fee_minor', () => {
  it('passes integers through untouched, including zero and large values', () => {
    for (const amount of [0, 1, 99, 2_147_483_647]) {
      const event = normalizeOne(polarEvent('order.paid', polarOrder({ net_amount: amount })))
      expect(event.observations[0]?.normalized.gross_minor).toBe(amount)
    }
  })

  it('refuses a non-integer amount rather than rounding it', () => {
    // A rounded amount is a wrong number that looks exactly like a right one.
    for (const amount of [49.99, '4999', null, 1e21]) {
      const outcome = adapter.normalizeEvent(
        polarEvent('order.paid', polarOrder({ net_amount: amount })),
        { headers: HEADERS },
      )
      expect(outcome.ok && outcome.event.ignored).toBe('unsupported_object_shape')
    }
  })

  it('treats a fee amount with NO currency as unknown, not as zero', () => {
    // The real sandbox shape: `platform_fee_amount: 0` beside
    // `platform_fee_currency: null` means "not settled yet".
    const event = normalizeOne(polarEvent('order.paid', polarOrder()))
    expect(event.observations[0]?.normalized).toMatchObject({
      fee_minor: 0,
      fee_currency: '',
      net_minor: 4999,
    })
  })

  it('reads a settled fee and deducts it from the same-currency gross', () => {
    const event = normalizeOne(
      polarEvent(
        'order.paid',
        polarOrder({ platform_fee_amount: 200, platform_fee_currency: 'USD' }),
      ),
    )
    expect(event.observations[0]?.normalized).toMatchObject({
      fee_minor: 200,
      fee_currency: 'usd',
      gross_minor: 4999,
      net_minor: 4799,
    })
  })

  it('records a cross-currency fee WITHOUT subtracting it from another currency', () => {
    // `gross - fee` across two currencies is not a smaller number, it is a
    // meaningless one.
    const event = normalizeOne(
      polarEvent(
        'order.paid',
        polarOrder({ platform_fee_amount: 180, platform_fee_currency: 'eur' }),
      ),
    )
    expect(event.observations[0]?.normalized).toMatchObject({
      fee_minor: 180,
      fee_currency: 'eur',
      currency: 'usd',
      net_minor: 4999,
    })
  })

  it('refuses a non-integer fee rather than rounding it', () => {
    const event = normalizeOne(
      polarEvent(
        'order.paid',
        polarOrder({ platform_fee_amount: 1.5, platform_fee_currency: 'usd' }),
      ),
    )
    expect(event.observations[0]?.normalized).toMatchObject({ fee_minor: 0, fee_currency: '' })
  })
})

describe('verifyWebhook', () => {
  const SECRET = `whsec_${'k'.repeat(43)}`
  const body = JSON.stringify(polarEvent('order.paid', polarOrder()))

  /** The instant a signed delivery is in tolerance. */
  const at = (headers: Record<string, string>) =>
    new Date(Number(headers['webhook-timestamp']) * 1000)

  it('accepts a delivery signed with THIS credential secret', () => {
    const headers = signStandardWebhook({ payload: body, secret: SECRET })
    expect(
      adapter.verifyWebhook({
        rawBody: body,
        signatureHeader: undefined,
        headers,
        signingSecret: SECRET,
        now: at(headers),
      }),
    ).toEqual({ ok: true })
  })

  it('rejects a delivery signed with another credential secret', () => {
    // The blast-radius property D1 chose over one shared platform secret: one
    // site's leaked secret verifies nothing on another site's endpoint.
    const headers = signStandardWebhook({ payload: body, secret: `whsec_${'x'.repeat(43)}` })
    expect(
      adapter.verifyWebhook({
        rawBody: body,
        signatureHeader: undefined,
        headers,
        signingSecret: SECRET,
        now: at(headers),
      }),
    ).toEqual({ ok: false, reason: 'no_matching_signature' })
  })

  it('rejects a body altered after signing', () => {
    const headers = signStandardWebhook({ payload: body, secret: SECRET })
    expect(
      adapter.verifyWebhook({
        rawBody: `${body} `,
        signatureHeader: undefined,
        headers,
        signingSecret: SECRET,
        now: at(headers),
      }),
    ).toEqual({ ok: false, reason: 'no_matching_signature' })
  })

  it('signs over the webhook-id, so a replayed body under another id fails', () => {
    // The id is part of the signed payload. Swapping it is a forgery, not a
    // relabelling.
    const headers = signStandardWebhook({ payload: body, secret: SECRET })
    expect(
      adapter.verifyWebhook({
        rawBody: body,
        signatureHeader: undefined,
        headers: { ...headers, 'webhook-id': 'whid_other' },
        signingSecret: SECRET,
        now: at(headers),
      }),
    ).toEqual({ ok: false, reason: 'no_matching_signature' })
  })

  it('reports a missing header set and a replayed timestamp distinctly', () => {
    expect(
      adapter.verifyWebhook({
        rawBody: body,
        signatureHeader: undefined,
        headers: {},
        signingSecret: SECRET,
      }),
    ).toEqual({ ok: false, reason: 'malformed_header' })

    const headers = signStandardWebhook({ payload: body, secret: SECRET, timestamp: 1_000 })
    expect(
      adapter.verifyWebhook({
        rawBody: body,
        signatureHeader: undefined,
        headers,
        signingSecret: SECRET,
        now: new Date(9_999_999_000),
      }),
    ).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' })
  })

  it('uses the RAW secret bytes, the deviation from the Standard Webhooks spec', () => {
    // Verified against real sandbox deliveries on 2026-08-27: Polar HMACs under
    // the literal `whsec_…` string, not the base64-decoded key the spec defines.
    // A spec-faithful signature must therefore FAIL — if this test ever goes
    // green both ways, the verifier has started accepting two different keys.
    const spec = signStandardWebhook({ payload: body, secret: SECRET, secretEncoding: 'base64' })
    expect(
      adapter.verifyWebhook({
        rawBody: body,
        signatureHeader: undefined,
        headers: spec,
        signingSecret: SECRET,
        now: at(spec),
      }),
    ).toEqual({ ok: false, reason: 'no_matching_signature' })
  })
})

// --- Network-facing members --------------------------------------------------

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

const WINDOW = {
  windowStart: new Date('2026-07-01T00:00:00.000Z'),
  windowEnd: new Date('2026-08-01T00:00:00.000Z'),
  pageSize: 100,
}

describe('listObjects', () => {
  it('walks OLDEST FIRST, which is ADR-0033 D4 as written', async () => {
    // Stripe's adapter had to record a deviation here: its lists are
    // reverse-chronological with no ordering parameter. Polar takes one — and it
    // has to be asked for, because Polar's own default is newest-first.
    const calls: string[] = []
    const client = createPolarRevenueAdapter(async (input) => {
      calls.push(String(input))
      return jsonResponse(polarListPage([polarOrder()]))
    })

    await client.listObjects('polar_oat_test', 'charges', { cursor: null, ...WINDOW })
    const url = new URL(calls[0] as string)
    expect(url.searchParams.get('sorting')).toBe('created_at')
  })

  it('binds the window, the page size and the trailing slash into the request', async () => {
    const calls: string[] = []
    const client = createPolarRevenueAdapter(async (input) => {
      calls.push(String(input))
      return jsonResponse(polarListPage([polarOrder()]))
    })

    await client.listObjects('polar_oat_test', 'charges', { cursor: null, ...WINDOW })
    const url = new URL(calls[0] as string)
    // The trailing slash is required: `/v1/orders` answers 307 to `/v1/orders/`.
    expect(url.pathname).toBe('/v1/orders/')
    expect(url.searchParams.get('created_after')).toBe('2026-07-01T00:00:00.000Z')
    expect(url.searchParams.get('created_before')).toBe('2026-08-01T00:00:00.000Z')
    expect(url.searchParams.get('limit')).toBe('100')
    expect(url.searchParams.get('page')).toBe('1')
  })

  it('resumes at the stored page and RE-SENDS the pinned cutoff', async () => {
    // The property the cursor exists for: page numbers alone are not resumable,
    // because rows created mid-walk shift every later page. Re-sending the
    // cutoff fixes the set being paged for the whole walk.
    const calls: string[] = []
    const client = createPolarRevenueAdapter(async (input) => {
      calls.push(String(input))
      return jsonResponse(polarListPage([polarOrder()], { max_page: 5 }))
    })

    const first = await client.listObjects('polar_oat_test', 'charges', {
      cursor: null,
      ...WINDOW,
    })
    expect(first.ok && first.page.nextCursor).toBe('2|2026-08-01T00:00:00.000Z')

    // Resume with a *different* windowEnd — the cursor's cutoff must win, or the
    // walk would page through a set that moved underneath it.
    await client.listObjects('polar_oat_test', 'charges', {
      cursor: '3|2026-08-01T00:00:00.000Z',
      ...WINDOW,
      windowEnd: new Date('2026-09-09T00:00:00.000Z'),
    })
    const resumed = new URL(calls[1] as string)
    expect(resumed.searchParams.get('page')).toBe('3')
    expect(resumed.searchParams.get('created_before')).toBe('2026-08-01T00:00:00.000Z')
  })

  it('reports an unreadable cursor as invalid_cursor, never as a bad credential', async () => {
    // Folding this into `unauthorized` would flip a working token to `degraded`,
    // terminal the backfill and tell the customer to check a key that works.
    const client = createPolarRevenueAdapter(async () => jsonResponse(polarListPage([])))
    for (const cursor of ['ch_stripe_style', '0|2026-08-01T00:00:00.000Z', 'x|y', '2|not-a-date']) {
      const outcome = await client.listObjects('polar_oat_test', 'charges', { cursor, ...WINDOW })
      expect(outcome.ok).toBe(false)
      expect(!outcome.ok && outcome.reason).toBe('invalid_cursor')
    }
  })

  it('nulls the cursor at the last page rather than storing a position', async () => {
    const done = createPolarRevenueAdapter(async () =>
      jsonResponse(polarListPage([polarOrder()], { max_page: 1 })),
    )
    const last = await done.listObjects('polar_oat_test', 'charges', { cursor: null, ...WINDOW })
    expect(last.ok && last.page).toMatchObject({ nextCursor: null, hasMore: false })
  })

  it('uses the OBJECT created_at as a list row snapshot time', async () => {
    // What makes a backfill row structurally unable to outrank a newer webhook.
    const client = createPolarRevenueAdapter(async () =>
      jsonResponse(polarListPage([polarOrder({ created_at: '2026-07-15T08:00:00.000Z' })])),
    )
    const outcome = await client.listObjects('polar_oat_test', 'charges', {
      cursor: null,
      ...WINDOW,
    })
    expect(outcome.ok && outcome.page.observations[0]?.snapshotAt.toISOString()).toBe(
      '2026-07-15T08:00:00.000Z',
    )
  })

  it('skips a row it cannot read without stalling the walk', async () => {
    const client = createPolarRevenueAdapter(async () =>
      jsonResponse(polarListPage([{ id: 'ord_broken' }, polarOrder()], { max_page: 2 })),
    )
    const outcome = await client.listObjects('polar_oat_test', 'charges', {
      cursor: null,
      ...WINDOW,
    })
    expect(outcome.ok && outcome.page.observations).toHaveLength(1)
    // The page number advances regardless: the cursor is Polar's pagination
    // position, not our success marker.
    expect(outcome.ok && outcome.page.nextCursor).toBe('2|2026-08-01T00:00:00.000Z')
  })

  it('refuses a list response with no items array instead of calling it empty', async () => {
    // Treating it as an empty page would silently complete a resource that was
    // never read. `unavailable`: the token clearly worked, something else did not.
    const client = createPolarRevenueAdapter(async () => jsonResponse({ pagination: {} }))
    const outcome = await client.listObjects('polar_oat_test', 'charges', {
      cursor: null,
      ...WINDOW,
    })
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toBe('unavailable')
  })

  describe('refunds — the window Polar will not apply', () => {
    it('does NOT send date parameters Polar silently ignores', async () => {
      // `/v1/refunds/` answers 200 to a malformed `created_after` while
      // `/v1/orders/` answers 422 — i.e. it ignores the parameter. A window
      // "applied" by an ignored parameter looks bounded and is not.
      const calls: string[] = []
      const client = createPolarRevenueAdapter(async (input) => {
        calls.push(String(input))
        return jsonResponse(polarListPage([]))
      })
      await client.listObjects('polar_oat_test', 'refunds', { cursor: null, ...WINDOW })
      const url = new URL(calls[0] as string)
      expect(url.pathname).toBe('/v1/refunds/')
      expect(url.searchParams.get('created_after')).toBeNull()
      expect(url.searchParams.get('created_before')).toBeNull()
    })

    it('applies the window itself and stops once the ascending walk passes it', async () => {
      const client = createPolarRevenueAdapter(async () =>
        jsonResponse(
          polarListPage(
            [
              polarRefund({ id: 'ref_before', created_at: '2026-06-01T00:00:00.000Z' }),
              polarRefund({ id: 'ref_inside', created_at: '2026-07-15T00:00:00.000Z' }),
              polarRefund({ id: 'ref_after', created_at: '2026-09-01T00:00:00.000Z' }),
            ],
            { max_page: 9 },
          ),
        ),
      )
      const outcome = await client.listObjects('polar_oat_test', 'refunds', {
        cursor: null,
        ...WINDOW,
      })
      expect(outcome.ok && outcome.page.observations.map((o) => o.objectId)).toEqual(['ref_inside'])
      // Ascending order means everything after `ref_after` is later still, so
      // there is nothing left in this window to walk — even at page 1 of 9.
      expect(outcome.ok && outcome.page).toMatchObject({ nextCursor: null, hasMore: false })
    })
  })

  it('returns one empty final page for disputes, without a request', async () => {
    // `/v1/disputes/` is a real endpoint, but Polar emits no `dispute.*` events
    // at all and no dispute object could be produced to verify a shape against,
    // so v1 reads none (D-P2). A normalizer written against an unseen payload
    // would be a guess.
    let called = false
    const client = createPolarRevenueAdapter(async () => {
      called = true
      return jsonResponse(polarListPage([]))
    })
    const outcome = await client.listObjects('polar_oat_test', 'disputes', {
      cursor: null,
      ...WINDOW,
    })
    expect(called).toBe(false)
    expect(outcome.ok && outcome.page).toEqual({
      observations: [],
      nextCursor: null,
      hasMore: false,
    })
  })
})

describe('adapter outcomes', () => {
  it('401 and 403 are unauthorized — the customer’s token, the customer’s fix', async () => {
    for (const status of [401, 403]) {
      const client = createPolarRevenueAdapter(async () => new Response('{}', { status }))
      const outcome = await client.listObjects('polar_oat_test', 'charges', {
        cursor: null,
        ...WINDOW,
      })
      expect(!outcome.ok && outcome.reason).toBe('unauthorized')
    }
  })

  it('429 is unavailable and carries Retry-After so the job can wait politely', async () => {
    const client = createPolarRevenueAdapter(
      async () => new Response('{}', { status: 429, headers: { 'retry-after': '12' } }),
    )
    const outcome = await client.listObjects('polar_oat_test', 'charges', {
      cursor: null,
      ...WINDOW,
    })
    expect(!outcome.ok && outcome.reason).toBe('unavailable')
    expect(!outcome.ok && outcome.retryAfterMs).toBe(12_000)
  })

  it('caps an absurd Retry-After rather than sleeping on a leased job', async () => {
    const client = createPolarRevenueAdapter(
      async () => new Response('{}', { status: 429, headers: { 'retry-after': '86400' } }),
    )
    const outcome = await client.listObjects('polar_oat_test', 'charges', {
      cursor: null,
      ...WINDOW,
    })
    expect(!outcome.ok && outcome.retryAfterMs).toBe(300_000)
  })

  it('5xx is unavailable — ours, not the credential’s', async () => {
    for (const status of [500, 502, 503]) {
      const client = createPolarRevenueAdapter(async () => new Response('{}', { status }))
      const outcome = await client.listObjects('polar_oat_test', 'charges', {
        cursor: null,
        ...WINDOW,
      })
      expect(!outcome.ok && outcome.reason).toBe('unavailable')
    }
  })

  it('422 on a cursor-bearing list is a cursor problem, not a key problem', async () => {
    // Polar spells validation failures 422 where Stripe spells them 400. Both
    // are residual, and on a list path the only variable the request carries is
    // the stored cursor.
    const client = createPolarRevenueAdapter(async () => new Response('{}', { status: 422 }))
    const withCursor = await client.listObjects('polar_oat_test', 'charges', {
      cursor: '2|2026-08-01T00:00:00.000Z',
      ...WINDOW,
    })
    expect(!withCursor.ok && withCursor.reason).toBe('invalid_cursor')

    const withoutCursor = await client.listObjects('polar_oat_test', 'charges', {
      cursor: null,
      ...WINDOW,
    })
    expect(!withoutCursor.ok && withoutCursor.reason).toBe('unauthorized')
  })

  it('a timeout or a dead socket is unavailable, never a thrown error', async () => {
    const client = createPolarRevenueAdapter(async () => {
      throw new Error('ECONNRESET')
    })
    const outcome = await client.listObjects('polar_oat_test', 'charges', {
      cursor: null,
      ...WINDOW,
    })
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toBe('unavailable')
  })

  it('never puts a provider response body in the detail', async () => {
    // These requests are made against a customer's own Polar account with their
    // own token, and the body of the answer is not ours to relay into a log line.
    const secretish = 'customer order for jane@example.com totalling 100 EUR'
    const client = createPolarRevenueAdapter(
      async () => new Response(JSON.stringify({ detail: secretish }), { status: 422 }),
    )
    const outcome = await client.listObjects('polar_oat_test', 'charges', {
      cursor: null,
      ...WINDOW,
    })
    expect(!outcome.ok && outcome.detail).not.toContain('jane@example.com')
    expect(!outcome.ok && outcome.detail).toBe('polar responded 422')
  })
})

describe('verifyCredential', () => {
  it('probes orders with limit=1 and never reads the body', async () => {
    const calls: string[] = []
    const client = createPolarRevenueAdapter(async (input) => {
      calls.push(String(input))
      return jsonResponse(polarListPage([polarOrder()]))
    })
    expect(await client.verifyCredential('polar_oat_test')).toEqual({ outcome: 'ok' })
    const url = new URL(calls[0] as string)
    expect(url.pathname).toBe('/v1/orders/')
    expect(url.searchParams.get('limit')).toBe('1')
  })

  it('splits a rejected token from an unreachable provider', async () => {
    const rejected = createPolarRevenueAdapter(async () => new Response('{}', { status: 401 }))
    expect(await rejected.verifyCredential('polar_oat_bad')).toMatchObject({
      outcome: 'unauthorized',
    })

    // An outage must never be reported as a bad credential — the split the whole
    // milestone is named after.
    const down = createPolarRevenueAdapter(async () => new Response('{}', { status: 503 }))
    expect(await down.verifyCredential('polar_oat_test')).toMatchObject({ outcome: 'unavailable' })

    const dead = createPolarRevenueAdapter(async () => {
      throw new Error('ENOTFOUND')
    })
    expect(await dead.verifyCredential('polar_oat_test')).toMatchObject({ outcome: 'unavailable' })
  })

  it('sends the token as a bearer credential and nothing else', async () => {
    let seen: Headers | undefined
    const client = createPolarRevenueAdapter(async (_input, init) => {
      seen = new Headers(init?.headers)
      return jsonResponse(polarListPage([]))
    })
    await client.verifyCredential('polar_oat_secret')
    expect(seen?.get('authorization')).toBe('Bearer polar_oat_secret')
  })
})

describe('fetchObject — the tie-break path', () => {
  it('addresses the right endpoint per kind, WITHOUT a trailing slash', async () => {
    // The opposite convention from the list paths: `/v1/orders/{id}/` answers
    // 307 to `/v1/orders/{id}`.
    const calls: string[] = []
    const client = createPolarRevenueAdapter(async (input) => {
      calls.push(String(input))
      return jsonResponse(polarOrder())
    })
    await client.fetchObject('polar_oat_test', 'charge', 'ord_test_1')
    expect(new URL(calls[0] as string).pathname).toBe('/v1/orders/ord_test_1')

    const refundClient = createPolarRevenueAdapter(async (input) => {
      calls.push(String(input))
      return jsonResponse(polarRefund())
    })
    await refundClient.fetchObject('polar_oat_test', 'refund', 'ref_test_1')
    expect(new URL(calls[1] as string).pathname).toBe('/v1/refunds/ref_test_1')
  })

  it('returns the authoritative observation', async () => {
    const client = createPolarRevenueAdapter(async () =>
      jsonResponse(polarOrder({ net_amount: 1234 })),
    )
    const outcome = await client.fetchObject('polar_oat_test', 'charge', 'ord_test_1')
    expect(outcome.ok && outcome.observation?.normalized.gross_minor).toBe(1234)
  })

  it('treats a 404 as a success with no object, not as a failure', async () => {
    // The tie-break asks "what is true now", and "this object does not exist" is
    // an answer. A failure would leave the ledger row `received` and make Polar
    // redeliver forever over an object it has itself forgotten.
    const client = createPolarRevenueAdapter(async () => new Response('{}', { status: 404 }))
    const outcome = await client.fetchObject('polar_oat_test', 'charge', 'ord_gone')
    expect(outcome).toEqual({ ok: true, observation: null, missing: true })
  })

  it('answers "missing" for a dispute without asking Polar', async () => {
    let called = false
    const client = createPolarRevenueAdapter(async () => {
      called = true
      return jsonResponse({})
    })
    const outcome = await client.fetchObject('polar_oat_test', 'dispute', 'dis_1')
    expect(called).toBe(false)
    expect(outcome).toEqual({ ok: true, observation: null, missing: true })
  })
})

describe('the environment is the base URL', () => {
  it('marks production livemode and a sandbox base not', async () => {
    // Polar has no `livemode` field on any object: sandbox and production are
    // separate hosts holding separate organizations, so there is nothing on a
    // payload to read and the base URL IS the environment.
    const live = createPolarRevenueAdapter(fetch, POLAR_API_BASE)
    const liveEvent = live.normalizeEvent(polarEvent('order.paid', polarOrder()), {
      headers: HEADERS,
    })
    expect(liveEvent.ok && liveEvent.event.observations[0]?.normalized.livemode).toBe(true)

    const sandbox = createPolarRevenueAdapter(fetch, 'https://sandbox-api.polar.sh/v1')
    const sandboxEvent = sandbox.normalizeEvent(polarEvent('order.paid', polarOrder()), {
      headers: HEADERS,
    })
    expect(sandboxEvent.ok && sandboxEvent.event.observations[0]?.normalized.livemode).toBe(false)
  })

  it('addresses the base URL it was given', async () => {
    const calls: string[] = []
    const client = createPolarRevenueAdapter(async (input) => {
      calls.push(String(input))
      return jsonResponse(polarListPage([]))
    }, 'https://sandbox-api.polar.sh/v1')
    await client.verifyCredential('polar_oat_test')
    expect(calls[0]).toContain('https://sandbox-api.polar.sh/v1/orders/')
  })

  it('defaults to production, so a missing argument is never a sandbox read', () => {
    expect(POLAR_API_BASE).toBe('https://api.polar.sh/v1')
  })
})
