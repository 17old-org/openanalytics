import {
  REVENUE_SYNC_RESOURCE_KINDS,
  revenueObservationHash,
  type RevenueAdapter,
  type RevenueCredentialVerification,
  type RevenueFetchOutcome,
  type RevenueIgnoreReason,
  type RevenueListOptions,
  type RevenueListOutcome,
  type RevenueMatchHint,
  type RevenueNormalizeOutcome,
  type RevenueNormalizedObject,
  type RevenueObjectKind,
  type RevenueObservation,
  type RevenueSyncResource,
  type RevenueWebhookVerification,
} from '@openanalytics/domain'
import { verifyStandardWebhookSignature } from './standard-webhooks-signature.ts'

/**
 * The Polar revenue adapter (ADR-0033, D1/D4; the D9 follow-up row for Polar).
 *
 * The second provider, and the thing it had to prove is that the second provider
 * is an **adapter** rather than an architecture. It is: no migration, no
 * environment variable, no OpenAPI change, no new grant. What it did cost is one
 * refactor the framework had already named — the webhook pipeline now hands an
 * adapter the whole header set, because Polar's event id is in a *header* and
 * `revenue-webhook.ts` could previously pass exactly one.
 *
 * SDK-free like the Stripe adapter beside it, for the same reason: `fetch`, a
 * typed outcome, and no third-party code on a path carrying a customer's own
 * key.
 *
 * The connection model is a customer-created **Organization Access Token** plus
 * a webhook endpoint they create in their Polar dashboard (D-P1). Polar can
 * register endpoints over the API — `POST /v1/webhooks/endpoints` returns the
 * secret — and doing so is a recorded follow-up; v1 keeps the existing two-step
 * connect so that adding a provider stays a catalog flip.
 *
 * ## What was verified against Polar's sandbox, and what was not
 *
 * Everything below was confirmed empirically on 2026-08-27 against
 * `sandbox-api.polar.sh` with a real organization, a real order and real signed
 * deliveries. The findings that contradict the documentation are the reason this
 * section exists rather than a link:
 *
 * - **The signing secret is not used as the spec says.** Standard Webhooks says
 *   the HMAC key is the base64 *decoded* secret with its `whsec_` prefix
 *   stripped. Polar HMACs under the secret's literal UTF-8 bytes, prefix
 *   included. A faithful implementation of the specification rejects every real
 *   Polar delivery. See `standard-webhooks-signature.ts`.
 * - **The event body carries no id.** The envelope is `{type, timestamp, data}`
 *   and nothing else, so the only stable delivery identity is the `webhook-id`
 *   header (D-P4). Confirmed stable across a forced retry — three attempts, one
 *   `webhook-id`, while `webhook-timestamp` and `webhook-signature` were
 *   regenerated for each attempt. That is exactly the dedupe property the ledger
 *   needs, and it is why the replay tolerance can stay at five minutes: a retry
 *   an hour later still arrives freshly signed.
 * - **Collection paths need a trailing slash and object paths must not have
 *   one.** `/v1/orders` answers 307 to `/v1/orders/`; `/v1/orders/{id}/` answers
 *   307 to `/v1/orders/{id}`. Both forms are spelled out below rather than
 *   assembled, because a redirect on an authenticated request is a class of
 *   silent breakage nobody goes looking for.
 * - **Validation failures are 422, not 400.** They land in the same residual-4xx
 *   split the Stripe adapter uses, which is what makes a stale cursor recoverable
 *   rather than a credential flipped to `degraded`.
 * - **Unknown query parameters are ignored silently.** `/v1/refunds/` accepts
 *   `created_after` with a 200 and pays no attention to it, while `/v1/orders/`
 *   rejects a malformed one with a 422 — i.e. orders filters by date and refunds
 *   does not. The window is therefore applied server-side for orders and in this
 *   module for refunds; see `listObjects`.
 * - **Not verified: refund events.** No live `refund.created`, `refund.updated`
 *   or `order.refunded` was observed, because a refund needs a non-zero paid
 *   order and Polar's Stripe account refuses publishable-key card tokenization,
 *   so no card could be charged headlessly. The zero-amount order that *was*
 *   created cannot be refunded. The refund normalizer is written from Polar's
 *   documented schema and its enums (confirmed by probing the API's own
 *   validation errors), and this is recorded in ADR-0033 as the one gap the
 *   sandbox pass did not close.
 *
 * ## What this module is and is not allowed to do
 *
 * The two rules are the port's, and they are not softened here:
 *
 * - **It never throws.** Every failure is a typed outcome, because a throw on
 *   the webhook path is a 500 on a signed delivery Polar retries, and a throw on
 *   the sync path is an unclassified job failure with no credential state behind
 *   it.
 * - **No response body leaves it.** `detail` is a status line or a reason word.
 * - **Amounts are integer passthrough.** Every amount is read from one of
 *   Polar's own integer minor-unit fields with `asInteger`. Nothing is parsed
 *   from a decimal, nothing is multiplied by 100, and a non-integer is refused
 *   rather than rounded.
 */

export const POLAR_REVENUE_PROVIDER_ID = 'polar'

/** Production. Sandbox is `https://sandbox-api.polar.sh/v1`, which the adapter
 * takes as a constructor argument so tests and a sandbox proof can point at it
 * without an environment variable existing (D-P8, D-P9). */
export const POLAR_API_BASE = 'https://api.polar.sh/v1'

/**
 * The probe: `GET /v1/orders/?limit=1` (D-P8).
 *
 * Orders is the resource every other one hangs off, so a token that can read it
 * is a token the sync path can start with. The response body is never read —
 * the question is "does this token work", not "what is in the account".
 */
const PROBE_PATH = '/orders/?limit=1'

/** A customer is waiting on a form submit, so this is a UX bound. */
const PROBE_TIMEOUT_MS = 10_000

/** The sync path's per-request deadline. Nobody is waiting; it is still a bound,
 * because a request with no deadline inside a leased job is a lease that expires
 * while a socket hangs. */
const SYNC_TIMEOUT_MS = 30_000

/** D4's page budget, and Polar's own documented list maximum. */
export const POLAR_LIST_PAGE_SIZE = 100

/**
 * The consumed event allowlist (D4, D-P2).
 *
 * The complete set of types Polar can send was read off the API's own validation
 * error for `POST /v1/webhooks/endpoints` — 41 types — so "unhandled" here means
 * a type that exists and is deliberately not read, never a type nobody checked
 * for. Anything outside this map is ledgered `ignored` and acked: an endpoint
 * subscribed broadly receives the organization's whole stream, and answering an
 * uninteresting type with a 4xx would make a customer's Polar dashboard show a
 * permanently failing endpoint.
 *
 * ## `order.refunded` produces a CHARGE, not a refund — a deviation from D-P2
 *
 * D-P2 maps `order.refunded` to a refund object. That cannot be implemented as
 * written: the event's `data` is an **Order**, so the only id it carries is the
 * order's, and `revenue_objects` is unique on `(site_id, provider, object_id)`
 * with **`object_kind` outside the key** (`0027_revenue_ingest.sql:145`). A
 * refund observation carrying the order's id would collide with the charge head
 * for that same order and the two would overwrite each other, flipping
 * `object_kind` back and forth on one row.
 *
 * So it maps the way Stripe's exactly-analogous `charge.refunded` does: it
 * updates the **charge**, whose status becomes `refunded` or
 * `partially_refunded` and whose gross is untouched — which is what D2d needs,
 * since the refund's own amount belongs in the refund's own bucket. The money
 * object for a refund comes from `refund.created`/`refund.updated`, which carry
 * a real Refund with an id of its own. Nothing is lost and the collision cannot
 * happen. Recorded in the ADR-0033 amendment.
 *
 * ## Why every order event runs through one rule
 *
 * D-P2 consumes `order.created`/`order.updated` as context-only "(unpaid)". They
 * are also emitted for orders that *are* paid — the sandbox delivered
 * `order.created`, `order.updated` and `order.paid` for one purchase — so the
 * rule is the order's own state rather than its event name: a paid-ish order
 * normalizes to a charge, anything else is understood-and-carried-no-money.
 * `order.paid` is always paid, so it always produces a charge; an unpaid
 * `order.created` is still `no_observations`, exactly as decided.
 */
const CONSUMED_EVENTS: Readonly<Record<string, 'order' | 'refund' | 'checkout' | null>> = {
  'order.paid': 'order',
  'order.refunded': 'order',
  'order.created': 'order',
  'order.updated': 'order',
  'refund.created': 'refund',
  'refund.updated': 'refund',
  /** Matching signal only (D-P2, D-P7). Carries no money object; see
   * `normalizeCheckoutHint`. */
  'checkout.updated': 'checkout',
  'checkout.created': 'checkout',
  /** Understood, and carrying no money object of their own — the order events
   * above are where a subscription's money actually arrives. */
  'subscription.created': null,
  'subscription.active': null,
  'subscription.updated': null,
  'subscription.canceled': null,
  'subscription.uncanceled': null,
  'subscription.revoked': null,
  'subscription.past_due': null,
  'subscription.paused': null,
  'subscription.resumed': null,
  'subscription.cycled': null,
}

/** The order statuses that mean money actually moved. Polar's own enum is
 * `draft | pending | paid | refunded | partially_refunded | void`. */
const PAID_ORDER_STATUSES: ReadonlySet<string> = new Set(['paid', 'refunded', 'partially_refunded'])

// --- Shape readers -----------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/**
 * A Polar integer minor-unit amount, or null.
 *
 * `Number.isSafeInteger` rather than `Number.isFinite`, for the reason the
 * Stripe adapter gives: a value Polar would never send but a corrupted body
 * might — `1234.5`, `1e21` — must be refused rather than rounded, because a
 * rounded amount is a wrong number that looks exactly like a right one for the
 * rest of its life.
 */
const asInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null

/**
 * An ISO-8601 timestamp → Date. Polar sends RFC 3339 with microseconds
 * (`2026-08-27T19:36:23.943060Z`), which `Date.parse` truncates to milliseconds
 * — the precision the ordering decision works in anyway.
 */
function isoToDate(value: unknown): Date | null {
  const raw = asString(value)
  if (raw === null) return null
  const at = Date.parse(raw)
  return Number.isNaN(at) ? null : new Date(at)
}

/** Lowercase ISO-4217, as D5 stores it. */
function currencyOf(object: Record<string, unknown>, key = 'currency'): string | null {
  const raw = asString(object[key])
  return raw === null ? null : raw.toLowerCase()
}

/**
 * A reference that may be an id string or a nested object.
 *
 * Polar sends `customer_id` flat *and* an expanded `customer` on the same order,
 * and which of the two a given payload carries has moved between API versions.
 * Reading only one form is the bug that made every `invoice.paid` ignored in
 * production on 2026-07-26; both are read here from the start.
 */
function referenceId(flat: unknown, nested: unknown): string {
  const direct = asString(flat)
  if (direct !== null && direct !== '') return direct
  const expanded = asRecord(nested)
  return expanded ? (asString(expanded['id']) ?? '') : ''
}

/**
 * The site's own opaque reference on an order or a checkout (D-P7).
 *
 * Precedence, and each step is a different thing a customer may already be
 * doing:
 *
 * 1. `customer.external_id` — Polar's own field for "the id this merchant knows
 *    this customer by". It is exactly D5's `external_user_hash` input and the
 *    same class of value `client_reference_id` has held raw since CP2.
 * 2. `metadata.oa_external_id` — OA's own documented metadata key (D5).
 * 3. `metadata.reference_id` — the key a Polar **checkout link** propagates into
 *    order metadata, which is what a customer following Polar's own docs will
 *    already have set.
 *
 * Raw, never hashed and never an email: the api holds no
 * `ANONYMOUS_IDENTITY_SECRET` and the worker derives the hash at projection time
 * (D6 amendment).
 */
function siteReference(object: Record<string, unknown>): string {
  const customer = asRecord(object['customer'])
  const external = customer ? asString(customer['external_id']) : null
  if (external !== null && external !== '') return external

  // `customer_external_id` is the checkout object's flat spelling of the same
  // value; an order carries it under the expanded customer.
  const flat = asString(object['customer_external_id'])
  if (flat !== null && flat !== '') return flat

  const metadata = asRecord(object['metadata'])
  if (!metadata) return ''
  for (const key of ['oa_external_id', 'reference_id']) {
    const value = asString(metadata[key])
    if (value !== null && value !== '') return value
  }
  return ''
}

/**
 * The platform fee, or null when it is not readable.
 *
 * Polar is a merchant of record and reports its cut on the order itself —
 * `platform_fee_amount` with `platform_fee_currency` — so, unlike Stripe, a fee
 * costs no expansion and no second request.
 *
 * `null` means **unknown**, and the sandbox showed exactly the case that makes
 * the distinction matter: `platform_fee_amount: 0` alongside
 * `platform_fee_currency: null`. A currency-less fee is a fee Polar has not
 * settled yet, not a fee of zero, and `fee_currency: ''` is the honest record of
 * that. What must not happen is a `fee_minor: 0` that reads as "this cost
 * nothing".
 */
interface PolarFee {
  readonly minor: number
  readonly currency: string
}

function platformFee(object: Record<string, unknown>): PolarFee | null {
  const minor = asInteger(object['platform_fee_amount'])
  const currency = currencyOf(object, 'platform_fee_currency')
  if (minor === null || currency === null || currency === '') return null
  return { minor, currency }
}

// --- Normalizers -------------------------------------------------------------

/**
 * Build the canonical snapshot with every field present.
 *
 * Absent strings are `''` rather than `undefined`, for the two reasons the
 * Stripe adapter gives: the document is hashed for the three-way decision, so a
 * field that is sometimes missing and sometimes empty would hash differently for
 * identical states; and CP3 writes it into ClickHouse `String` columns, which
 * have no null.
 */
function snapshot(
  base: Pick<RevenueNormalizedObject, 'object_kind' | 'status' | 'livemode' | 'currency'>,
  amounts: { gross: number; fee: PolarFee | null },
  occurredAt: Date,
  refs: Partial<
    Pick<
      RevenueNormalizedObject,
      | 'parent_object_id'
      | 'order_id'
      | 'checkout_session_id'
      | 'client_reference_id'
      | 'subscription_id'
      | 'product_id'
      | 'product_name'
      | 'customer_id'
    >
  >,
): RevenueNormalizedObject {
  // A fee is only subtractable from a gross denominated in the same currency.
  // Polar settles a merchant of record's fee in the order's currency in the
  // ordinary case, but the field is its own and the guard costs nothing — and
  // `gross - fee` across two currencies is not a smaller number, it is a
  // meaningless one.
  const sameCurrency = amounts.fee !== null && amounts.fee.currency === base.currency

  return {
    object_kind: base.object_kind,
    status: base.status,
    livemode: base.livemode,
    currency: base.currency,
    gross_minor: amounts.gross,
    fee_minor: amounts.fee?.minor ?? 0,
    fee_currency: amounts.fee?.currency ?? '',
    net_minor: sameCurrency ? amounts.gross - (amounts.fee?.minor ?? 0) : amounts.gross,
    occurred_at: occurredAt.toISOString(),
    parent_object_id: refs.parent_object_id ?? '',
    order_id: refs.order_id ?? '',
    checkout_session_id: refs.checkout_session_id ?? '',
    client_reference_id: refs.client_reference_id ?? '',
    subscription_id: refs.subscription_id ?? '',
    product_id: refs.product_id ?? '',
    product_name: refs.product_name ?? '',
    customer_id: refs.customer_id ?? '',
  }
}

/**
 * An order's status in D5's vocabulary.
 *
 * Mostly a passthrough, because Polar's own enum already contains `refunded` and
 * `partially_refunded` — the two states Stripe makes you derive. The derivation
 * is kept anyway, and only ever *promotes* a `paid` order that carries a
 * non-zero `refunded_amount`: an order whose refund has been recorded on it but
 * whose status has not caught up would otherwise render as a clean sale, which
 * is telling the truth about the payment and lying about the money.
 *
 * The order's own gross is deliberately untouched by this — D2d puts the
 * refund's amount in the refund's bucket, not against the charge.
 */
function orderStatus(object: Record<string, unknown>): string {
  const status = asString(object['status'])
  if (status === 'refunded' || status === 'partially_refunded') return status

  const refunded = asInteger(object['refunded_amount']) ?? 0
  if (refunded > 0) {
    const net = asInteger(object['net_amount']) ?? 0
    return refunded >= net && net > 0 ? 'refunded' : 'partially_refunded'
  }
  return status === null || status === '' ? 'pending' : status
}

/**
 * An Order → a charge observation (D-P3).
 *
 * ## The amount is `net_amount`, and that is a parity decision
 *
 * Polar is a **merchant of record**: it collects tax and remits it, so
 * `total_amount` includes money the seller never receives. The sandbox order
 * confirmed the arithmetic exactly — `subtotal_amount 2500 − discount_amount
 * 2500 = net_amount 0`, and `total_amount 0 = net_amount + tax_amount 0` — so
 * `net_amount` is the post-discount, pre-tax figure, which is both the seller's
 * revenue and the number Polar's own dashboard reports. Using `total_amount`
 * would overstate every order by its tax.
 *
 * Returns null when a required field is missing or the wrong shape, which the
 * caller turns into `unsupported_object_shape` rather than a zero.
 */
function normalizeOrder(
  object: Record<string, unknown>,
  livemode: boolean,
): RevenueObservation | null {
  const objectId = asString(object['id'])
  const currency = currencyOf(object)
  const gross = asInteger(object['net_amount'])
  const created = isoToDate(object['created_at'])
  if (objectId === null || currency === null || gross === null || created === null) return null

  const product = asRecord(object['product'])

  return {
    objectId,
    objectKind: 'charge',
    snapshotAt: created,
    normalized: snapshot(
      { object_kind: 'charge', status: orderStatus(object), livemode, currency },
      { gross, fee: platformFee(object) },
      created,
      {
        // Polar's order id is the order identity. There is no PaymentIntent
        // layer here — an order is not retried into several charges the way a
        // Stripe PaymentIntent is — so the object's own id is the join key, and
        // it is what a refund's `order_id` points back at.
        order_id: objectId,
        checkout_session_id: asString(object['checkout_id']) ?? '',
        client_reference_id: siteReference(object),
        customer_id: referenceId(object['customer_id'], object['customer']),
        subscription_id: referenceId(object['subscription_id'], object['subscription']),
        product_id: referenceId(object['product_id'], object['product']),
        product_name: product ? (asString(product['name']) ?? '') : '',
      },
    ),
  }
}

/**
 * A Refund → a refund observation.
 *
 * The refund's **own** `amount`, with its `tax_amount` excluded — symmetric with
 * the order reading `net_amount`, so a full refund of an order nets to zero
 * against the charge it reverses instead of over-crediting it by the tax Polar
 * remitted on the seller's behalf.
 *
 * `fee` is deliberately left unread rather than set to zero. Polar exposes no
 * fee field on a refund, so whether it reverses its platform fee is a claim
 * about the provider this milestone has not verified against a real refund —
 * and `fee_currency: ''` says "unknown", which is the honest answer.
 * `RevenueTotals` already documents refund rows as contributing no fee, so this
 * matches the shipped contract.
 *
 * **Written from the documented schema, not from an observed event.** See the
 * module header: no live refund could be produced in the sandbox.
 */
function normalizeRefund(
  object: Record<string, unknown>,
  livemode: boolean,
): RevenueObservation | null {
  const objectId = asString(object['id'])
  const currency = currencyOf(object)
  const gross = asInteger(object['amount'])
  const created = isoToDate(object['created_at'])
  if (objectId === null || currency === null || gross === null || created === null) return null

  const orderId = referenceId(object['order_id'], object['order'])

  return {
    objectId,
    objectKind: 'refund',
    snapshotAt: created,
    normalized: snapshot(
      {
        object_kind: 'refund',
        // `succeeded | pending | failed | canceled` — Polar's four are already
        // D5's four, so this is a passthrough rather than a mapping.
        status: asString(object['status']) ?? 'pending',
        livemode,
        currency,
      },
      { gross, fee: null },
      created,
      {
        // The charge this refund reduces. Our charge head for a Polar order is
        // keyed on the order's id, so the parent link resolves directly.
        parent_object_id: orderId,
        order_id: orderId,
        customer_id: referenceId(object['customer_id'], object['customer']),
        subscription_id: referenceId(object['subscription_id'], object['subscription']),
      },
    ),
  }
}

/**
 * A Checkout → a match hint (D-P2, D-P7).
 *
 * Returns null without an id: the id is the hint's uniqueness key, and without
 * it a redelivery would insert a second row rather than update the first.
 *
 * `orderId` is **always empty**, and that is a property of Polar rather than an
 * omission. A checkout does not know the order it will produce — the order is
 * created afterwards and is the object that carries `checkout_id` — so the join
 * runs the other way, from the charge's `checkout_session_id` to this hint's
 * `checkoutSessionId`. `RevenueMatchHint.orderId` already documents the empty
 * case for exactly this shape.
 *
 * A customer email is never read, in any form: D-102 forbids storing it and the
 * api cannot hash it.
 */
function normalizeCheckoutHint(
  object: Record<string, unknown>,
  eventAt: Date,
): RevenueMatchHint | null {
  const checkoutSessionId = asString(object['id'])
  if (checkoutSessionId === null || checkoutSessionId === '') return null

  return {
    checkoutSessionId,
    orderId: '',
    clientReferenceId: siteReference(object),
    customerId: referenceId(object['customer_id'], object['customer']),
    // The event's time rather than the checkout's `created_at`: a checkout is
    // opened once and updated many times, so its creation time is not when this
    // match became true.
    occurredAt: eventAt,
  }
}

// --- The cursor --------------------------------------------------------------

/**
 * The pagination position, persisted verbatim in `revenue_sync_state.cursor`.
 *
 * Polar paginates by **page number**, which on its own is not safe to resume
 * from: rows created while a walk is in progress shift every later page and a
 * resumed walk would skip whatever moved across a boundary. So the cursor
 * carries the page *and the cutoff instant the walk was pinned to* — the window
 * end at the time the first page was read — and every page re-sends that cutoff
 * as `created_before`. The set being paged is then fixed for the whole walk and
 * a page number means the same thing on resume as it did when it was written.
 *
 * `page|cutoffISO`, opaque to the pipeline exactly as Stripe's `starting_after`
 * is. A cursor this module cannot parse is an `invalid_cursor` — drop it and
 * re-walk the window — rather than a silent restart at page one, which would
 * re-read the whole window and look like progress.
 */
interface PolarCursor {
  readonly page: number
  readonly cutoff: Date
}

function encodeCursor(cursor: PolarCursor): string {
  return `${String(cursor.page)}|${cursor.cutoff.toISOString()}`
}

function decodeCursor(raw: string): PolarCursor | null {
  const bar = raw.indexOf('|')
  if (bar < 0) return null
  const page = Number(raw.slice(0, bar))
  if (!Number.isSafeInteger(page) || page < 1) return null
  const cutoff = Date.parse(raw.slice(bar + 1))
  if (Number.isNaN(cutoff)) return null
  return { page, cutoff: new Date(cutoff) }
}

// --- HTTP helpers ------------------------------------------------------------

/** Bounded at five minutes: a header asking a leased job to sleep for an hour is
 * a header to disregard, since the runner's backoff brings the job back sooner
 * and more safely than an in-job sleep of that length. */
const MAX_RETRY_AFTER_MS = 300_000

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')
  if (header === null) return undefined
  const seconds = Number(header.trim())
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
  }
  const at = Date.parse(header)
  if (Number.isNaN(at)) return undefined
  return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS)
}

interface PolarGetSuccess {
  readonly ok: true
  readonly body: Record<string, unknown>
}
interface PolarGetFailure {
  readonly ok: false
  readonly reason: 'unavailable' | 'unauthorized' | 'invalid_cursor'
  readonly detail: string
  readonly retryAfterMs?: number
  /** Polar answered 404: the object is not there, as opposed to the request
   * being wrong. Only `fetchObject` has a use for the distinction. */
  readonly missing?: boolean
}

/**
 * One authenticated GET, with every failure typed.
 *
 * The residual-4xx split is the Stripe adapter's and exists for the same reason:
 * every path and query this module sends is built here, so there is no shape of
 * request a *customer* can make invalid — except the one that comes from a
 * **stored value**, the pagination cursor. Folding a bad cursor into
 * `unauthorized` would flip a working credential to `degraded`, terminal the
 * backfill and tell the customer to check a key that works. On a list path a
 * residual 4xx is therefore `invalid_cursor` (drop it and re-walk); everywhere
 * else it stays `unauthorized`, whose recovery — check the token and its scopes
 * — is the actionable one.
 *
 * Polar spells validation failures `422` where Stripe spells them `400`. Both
 * are residual, so both land in the same split without a special case.
 */
async function polarGet(
  fetchImpl: typeof fetch,
  baseUrl: string,
  accessToken: string,
  path: string,
  options: { readonly cursorSensitive?: boolean } = {},
): Promise<PolarGetSuccess | PolarGetFailure> {
  let response: Response
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    })
  } catch {
    // DNS, TLS, a reset socket or our own deadline. All of them mean "we could
    // not ask", and none is evidence about the customer's token.
    return { ok: false, reason: 'unavailable', detail: 'polar request did not complete' }
  }

  if (response.status === 429) {
    const after = retryAfterMs(response)
    return {
      ok: false,
      reason: 'unavailable',
      detail: 'polar responded 429',
      ...(after === undefined ? {} : { retryAfterMs: after }),
    }
  }
  if (response.status >= 500) {
    return {
      ok: false,
      reason: 'unavailable',
      detail: `polar responded ${String(response.status)}`,
    }
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      reason: 'unauthorized',
      detail: `polar responded ${String(response.status)}`,
    }
  }

  const residual: PolarGetFailure['reason'] =
    options.cursorSensitive === true ? 'invalid_cursor' : 'unauthorized'

  if (response.status === 404) {
    return { ok: false, reason: residual, detail: 'polar responded 404', missing: true }
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok || body === null) {
    return { ok: false, reason: residual, detail: `polar responded ${String(response.status)}` }
  }
  return { ok: true, body }
}

/**
 * Collection paths, **with the trailing slash Polar requires**.
 *
 * `/v1/orders` answers 307 to `/v1/orders/`. `fetch` would follow it and the
 * request would still work, which is precisely what makes the missing slash the
 * kind of thing that survives review and doubles every list request in
 * production.
 */
const LIST_PATHS: Readonly<Record<RevenueSyncResource, string>> = {
  charges: '/orders/',
  refunds: '/refunds/',
  disputes: '/disputes/',
}

/** Single-object paths, **without** a trailing slash — the opposite convention,
 * verified: `/v1/orders/{id}/` answers 307 to `/v1/orders/{id}`. */
const OBJECT_PATHS: Readonly<Record<RevenueObjectKind, string>> = {
  charge: '/orders',
  refund: '/refunds',
  dispute: '/disputes',
}

/**
 * Which resources accept `created_after` / `created_before`.
 *
 * **Only orders.** `/v1/refunds/` and `/v1/disputes/` accept the parameters with
 * a 200 and ignore them — verified by sending a deliberately malformed date and
 * watching orders answer 422 while the others answered 200 with a full page. A
 * window "applied" by an ignored parameter is the worst of both worlds: it looks
 * bounded and is not.
 */
const SERVER_SIDE_WINDOW: Readonly<Record<RevenueSyncResource, boolean>> = {
  charges: true,
  refunds: false,
  disputes: false,
}

// --- The adapter -------------------------------------------------------------

export function createPolarRevenueAdapter(
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = POLAR_API_BASE,
): RevenueAdapter {
  // Polar has no `livemode` field on any object: sandbox and production are
  // separate hosts holding separate organizations, so the environment IS the
  // base URL and there is nothing on a payload to read. Derived once here rather
  // than guessed per object.
  const livemode = baseUrl === POLAR_API_BASE

  const normalizers: Readonly<
    Record<RevenueObjectKind, (object: Record<string, unknown>) => RevenueObservation | null>
  > = {
    charge: (object) => normalizeOrder(object, livemode),
    refund: (object) => normalizeRefund(object, livemode),
    // Unreachable in v1 — no event maps to it and `listObjects` returns an empty
    // page — but present so the record is total and a future dispute normalizer
    // has one obvious place to land.
    dispute: () => null,
  }

  return {
    providerId: POLAR_REVENUE_PROVIDER_ID,

    async verifyCredential(secretKey: string): Promise<RevenueCredentialVerification> {
      let response: Response
      try {
        response = await fetchImpl(`${baseUrl}${PROBE_PATH}`, {
          method: 'GET',
          headers: { authorization: `Bearer ${secretKey}`, accept: 'application/json' },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
      } catch {
        return { outcome: 'unavailable', detail: 'polar probe did not complete' }
      }

      if (response.status === 401 || response.status === 403) {
        // 401 is a token Polar does not recognise (revoked, mistyped, wrong
        // organization); 403 is a token without the orders scope. Both are the
        // customer's to fix in their own dashboard, and the recovery is one
        // sentence for either.
        return { outcome: 'unauthorized', detail: `polar responded ${String(response.status)}` }
      }
      if (response.status === 429 || response.status >= 500) {
        return { outcome: 'unavailable', detail: `polar responded ${String(response.status)}` }
      }
      if (!response.ok) {
        // The request is built entirely by this module, so there is no shape of
        // it a customer could make invalid. A residual 4xx therefore means the
        // token did not buy the read.
        return { outcome: 'unauthorized', detail: `polar responded ${String(response.status)}` }
      }

      // The body is deliberately not read: it is a page of a customer's real
      // orders, and this call's only question is answered by the status line.
      return { outcome: 'ok' }
    },

    /**
     * Signature verification, delegated to the Standard Webhooks verifier.
     *
     * Three headers, not one — which is why the port hands an adapter the whole
     * header set (D-P4). `secretEncoding: 'raw'` is the empirically verified
     * deviation from the specification and is the single most load-bearing line
     * in this file; the module it calls explains why.
     */
    verifyWebhook(input): RevenueWebhookVerification {
      const headers = input.headers ?? {}
      const verified = verifyStandardWebhookSignature({
        rawBody: input.rawBody,
        webhookId: headers['webhook-id'],
        webhookTimestamp: headers['webhook-timestamp'],
        signatureHeader: headers['webhook-signature'],
        secret: input.signingSecret,
        secretEncoding: 'raw',
        ...(input.now === undefined ? {} : { now: input.now }),
      })
      return verified.ok ? { ok: true } : { ok: false, reason: verified.reason }
    },

    /**
     * A Polar event → zero or more canonical observations.
     *
     * **The event id comes from the header set, not the body** (D-P4): Polar's
     * envelope is `{type, timestamp, data}` and carries no id at all. The
     * `webhook-id` header is the delivery identity and is constant across
     * retries, which is the exact property `revenue_provider_events` needs to
     * dedupe a redelivery. Without it there is nothing to ledger, so a body with
     * no header set is `malformed_event` rather than an event with a fabricated
     * id.
     */
    normalizeEvent(parsedEvent: unknown, context): RevenueNormalizeOutcome {
      const event = asRecord(parsedEvent)
      const eventType = event ? asString(event['type']) : null
      const eventAt = event ? isoToDate(event['timestamp']) : null
      const eventId = context?.headers?.['webhook-id']
      if (!event || eventType === null || eventAt === null || !eventId) {
        return { ok: false, reason: 'malformed_event' }
      }

      const base = { eventId, eventType, eventAt }

      if (!(eventType in CONSUMED_EVENTS)) return ignored(base, 'unhandled_event_type')
      const kind = CONSUMED_EVENTS[eventType]
      if (kind === null || kind === undefined) return ignored(base, 'no_observations')

      const object = asRecord(event['data'])
      if (!object) return ignored(base, 'unsupported_object_shape')

      if (kind === 'checkout') {
        const hint = normalizeCheckoutHint(object, eventAt)
        if (hint) return { ok: true, event: { ...base, observations: [], hints: [hint] } }
        return ignored(base, 'no_observations')
      }

      if (kind === 'order' && !PAID_ORDER_STATUSES.has(asString(object['status']) ?? '')) {
        // Understood, and carrying no money yet — a draft or pending order. Its
        // own event will arrive when it is paid.
        return ignored(base, 'no_observations')
      }

      const observation = normalizers[kind === 'order' ? 'charge' : 'refund'](object)
      if (!observation) return ignored(base, 'unsupported_object_shape')

      return {
        ok: true,
        event: {
          ...base,
          // **The event's time, not the object's.** The webhook's ordering input
          // is when the provider said this state was true; the object's own
          // `created_at` never moves, so using it would make every update to one
          // order carry the same snapshot time and collapse into a permanent
          // equal-timestamp tie.
          observations: [{ ...observation, snapshotAt: eventAt }],
        },
      }
    },

    /**
     * One page of a list endpoint.
     *
     * ## The walk is oldest-first, which Stripe could not do
     *
     * ADR-0033 D4 says the backfill walks its window oldest first, and CP2 had to
     * record a deviation because Stripe's list endpoints are reverse-chronological
     * with no ordering parameter. Polar takes `sorting=created_at`, so **this
     * adapter satisfies D4 as written** — the deviation is Stripe's alone, and
     * an interrupted Polar backfill holds a contiguous oldest-first prefix of the
     * window.
     *
     * It has to be asked for explicitly: Polar's own default is `-created_at`,
     * newest first.
     *
     * ## Disputes return one empty final page
     *
     * `/v1/disputes/` is a **real endpoint** — it validates its own `sorting`
     * enum, where a fabricated path 404s — so the honest statement is not that
     * Polar has no disputes but that this adapter does not read them (D-P2). Two
     * reasons, both the same one the Stripe adapter gives for not reading a
     * dispute's fee: Polar emits **no `dispute.*` webhook events at all** (read
     * off the API's own list of 41 event types), so nothing would keep a dispute
     * head current between sweeps; and no dispute object could be produced in the
     * sandbox, so its shape is unverified and a normalizer written against it
     * would be a guess. Recorded as a follow-up in ADR-0033 rather than shipped
     * unproven.
     */
    async listObjects(
      secretKey: string,
      resource: RevenueSyncResource,
      options: RevenueListOptions,
    ): Promise<RevenueListOutcome> {
      if (resource === 'disputes') {
        return { ok: true, page: { observations: [], nextCursor: null, hasMore: false } }
      }

      let cursor: PolarCursor
      if (options.cursor !== null && options.cursor !== '') {
        const decoded = decodeCursor(options.cursor)
        if (decoded === null) {
          // A cursor written by an older build, or a corrupted row. Recoverable
          // by dropping it and re-walking — which is the caller's decision, and
          // the reason this is its own reason rather than `unauthorized`.
          return { ok: false, reason: 'invalid_cursor', detail: 'polar cursor is unreadable' }
        }
        cursor = decoded
      } else {
        // First page of the walk: pin the cutoff to the window end, so every
        // later page pages through a set that cannot grow underneath it.
        cursor = { page: 1, cutoff: options.windowEnd }
      }

      const limit = Math.min(Math.max(options.pageSize, 1), POLAR_LIST_PAGE_SIZE)
      const query = new URLSearchParams({
        limit: String(limit),
        page: String(cursor.page),
        // Ascending — D4's oldest-first, and not the default.
        sorting: 'created_at',
      })
      if (SERVER_SIDE_WINDOW[resource]) {
        query.set('created_after', options.windowStart.toISOString())
        query.set('created_before', cursor.cutoff.toISOString())
      }

      const result = await polarGet(
        fetchImpl,
        baseUrl,
        secretKey,
        `${LIST_PATHS[resource]}?${query.toString()}`,
        // The one request this module makes that carries a stored value.
        { cursorSensitive: options.cursor !== null && options.cursor !== '' },
      )
      if (!result.ok) return failure(result)

      const items = result.body['items']
      if (!Array.isArray(items)) {
        // A list response with no `items` array is not a page we can walk, and
        // treating it as an empty page would silently complete a resource that
        // was never read. `unavailable` rather than `unauthorized`: the token
        // clearly worked, something else did not.
        return { ok: false, reason: 'unavailable', detail: 'polar list response has no items' }
      }

      const kind = REVENUE_SYNC_RESOURCE_KINDS[resource]
      const normalize = normalizers[kind]
      const observations: RevenueObservation[] = []
      // Only meaningful for a resource whose window this module has to apply
      // itself; see `SERVER_SIDE_WINDOW`.
      let pastWindow = false

      for (const row of items) {
        const object = asRecord(row)
        if (!object) continue
        const observation = normalize(object)
        // A list row's snapshot time is the OBJECT's own `created_at` (D4), which
        // is what the normalizer already set — so nothing overrides it here, and
        // that is the property making a backfill row structurally unable to
        // outrank a newer webhook for the same object.
        if (!observation) continue

        if (!SERVER_SIDE_WINDOW[resource]) {
          const at = observation.snapshotAt.getTime()
          if (at < options.windowStart.getTime()) continue
          if (at > options.windowEnd.getTime()) {
            // The walk is ascending, so everything after this row is later still.
            pastWindow = true
            continue
          }
        }
        observations.push(observation)
      }

      const pagination = asRecord(result.body['pagination'])
      const maxPage = pagination ? (asInteger(pagination['max_page']) ?? 0) : 0
      const hasMore = !pastWindow && cursor.page < maxPage

      return {
        ok: true,
        page: {
          observations,
          // Null at the end of the walk rather than the next page number, so a
          // caller that stores it verbatim records "finished" rather than a
          // position it would resume from and re-read.
          nextCursor: hasMore
            ? encodeCursor({ page: cursor.page + 1, cutoff: cursor.cutoff })
            : null,
          hasMore,
        },
      }
    },

    async fetchObject(
      secretKey: string,
      objectKind: RevenueObjectKind,
      objectId: string,
    ): Promise<RevenueFetchOutcome> {
      if (objectKind === 'dispute') {
        // Nothing reads disputes in v1, so there is no object to be
        // authoritative about. Reported as "the provider has no such object",
        // which is the answer that lets a tie resolve as a skip instead of a
        // retry that could never succeed.
        return { ok: true, observation: null, missing: true }
      }

      const result = await polarGet(
        fetchImpl,
        baseUrl,
        secretKey,
        `${OBJECT_PATHS[objectKind]}/${encodeURIComponent(objectId)}`,
      )
      if (!result.ok) {
        // A 404 is a *success* for the caller's purpose: the tie-break asks
        // "what is true now", and "this object does not exist" is an answer.
        // Reporting it as a failure would leave the ledger row `received` and
        // make Polar redeliver forever over an object it has itself forgotten.
        if (result.missing === true) return { ok: true, observation: null, missing: true }
        return failure(result)
      }

      const observation = normalizers[objectKind](result.body)
      if (!observation) {
        return { ok: false, reason: 'unavailable', detail: 'polar object could not be read' }
      }
      return { ok: true, observation }
    },
  }
}

function ignored(
  base: { eventId: string; eventType: string; eventAt: Date },
  reason: RevenueIgnoreReason,
): RevenueNormalizeOutcome {
  return { ok: true, event: { ...base, observations: [], ignored: reason } }
}

/** A typed GET failure, narrowed to the adapter's public failure shape. */
function failure(result: PolarGetFailure): RevenueListOutcome & RevenueFetchOutcome {
  return {
    ok: false,
    reason: result.reason,
    detail: result.detail,
    ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
  }
}

export { revenueObservationHash }
