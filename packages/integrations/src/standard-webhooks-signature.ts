import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Standard Webhooks signature verification (https://www.standardwebhooks.com).
 *
 * Its own module, and deliberately named for the *scheme* rather than for the
 * provider that brought it: Polar signs this way, and so do Paddle, Svix and
 * everything else built on the same spec. `stripe-signature.ts` sits beside it
 * for the one provider that predates the standard and signs its own way.
 *
 * Verified directly rather than through a library, for the reason the Stripe
 * verifier has none: the scheme is a small, well-specified HMAC on a path that
 * carries a *customer's own* signing secret, and the security-critical code on
 * that path should have no third-party author.
 *
 * ## The signed payload
 *
 * `${webhook-id}.${webhook-timestamp}.${rawBody}`, HMAC-SHA256, base64. Three
 * headers carry it — `webhook-id`, `webhook-timestamp`, `webhook-signature` —
 * and the last is a space-separated list of `version,signature` pairs so a
 * secret can be rotated without dropping a delivery. Only `v1` is a scheme this
 * module knows; anything else in the list is skipped rather than refused,
 * because a future version arriving beside a v1 we can check is not a reason to
 * reject a delivery we *can* authenticate.
 *
 * ## Why the key derivation is a parameter
 *
 * The spec says the secret is `whsec_` followed by base64, and that the HMAC key
 * is those base64 bytes **decoded** — the prefix stripped, the rest a 32-byte
 * key.
 *
 * **Polar does not do that.** Verified empirically against sandbox deliveries on
 * 2026-08-27: Polar HMACs under the secret's *literal UTF-8 bytes, `whsec_`
 * prefix included*. A faithful implementation of the spec rejects every genuine
 * Polar delivery, and a verifier that silently accepted either derivation would
 * be a verifier that accepts signatures under two different keys — which is not
 * a compatibility shim, it is a weaker check.
 *
 * So the derivation is named at the call site and nowhere else. `raw` is Polar's
 * and is documented as a deviation in ADR-0033; `base64` is the spec's, and is
 * the default so that a future adapter written from the specification is correct
 * by writing nothing.
 */

export type StandardWebhookFailure =
  /** A required header was absent or unparseable — including a `webhook-signature`
   * carrying no `v1` entry at all. */
  'malformed_header' | 'timestamp_out_of_tolerance' | 'no_matching_signature'

export type StandardWebhookResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: StandardWebhookFailure }

/** Replay tolerance. The same 300 s the Stripe verifier uses, and the spec's own
 * recommendation; there is no reason for two providers' replay windows to differ. */
export const STANDARD_WEBHOOK_TOLERANCE_SECONDS = 300

/**
 * How the stored secret becomes the HMAC key.
 *
 * - `base64` — the specification: strip a `whsec_` prefix if present, base64-decode
 *   the rest.
 * - `raw` — the secret's literal UTF-8 bytes, prefix and all. What Polar does.
 */
export type StandardWebhookSecretEncoding = 'base64' | 'raw'

const WHSEC_PREFIX = 'whsec_'

function hmacKey(secret: string, encoding: StandardWebhookSecretEncoding): Buffer {
  if (encoding === 'raw') return Buffer.from(secret, 'utf8')
  const body = secret.startsWith(WHSEC_PREFIX) ? secret.slice(WHSEC_PREFIX.length) : secret
  return Buffer.from(body, 'base64')
}

/**
 * The `v1` signatures in a `webhook-signature` header.
 *
 * Entries are space-separated `version,signature` pairs. An entry with no comma,
 * or with a version this module does not implement, is skipped — see the note on
 * `malformed_header` above.
 */
function parseSignatureHeader(header: string): string[] {
  const signatures: string[] = []
  for (const entry of header.split(' ')) {
    const comma = entry.indexOf(',')
    if (comma < 0) continue
    if (entry.slice(0, comma).trim() !== 'v1') continue
    const signature = entry.slice(comma + 1).trim()
    if (signature !== '') signatures.push(signature)
  }
  return signatures
}

/**
 * Constant-time compare of two base64 signatures.
 *
 * Decoded to bytes before comparing, so two encodings of the same signature — a
 * padded and an unpadded form, base64 and base64url — do not read as a mismatch.
 * `timingSafeEqual` throws on a length mismatch, so lengths are checked first;
 * a differing length is already a non-match and leaks nothing a caller who sent
 * the signature does not already know.
 */
function safeEqualBase64(candidate: string, expected: Buffer): boolean {
  const given = Buffer.from(candidate, 'base64')
  if (given.length !== expected.length) return false
  return timingSafeEqual(given, expected)
}

/**
 * Verify a Standard Webhooks delivery against the raw request body.
 *
 * Never throws: every outcome is a typed reason, because the caller is a webhook
 * route and a throw there is a 500 on a signed delivery the provider will retry
 * forever.
 */
export function verifyStandardWebhookSignature(input: {
  readonly rawBody: string
  readonly webhookId: string | undefined
  readonly webhookTimestamp: string | undefined
  readonly signatureHeader: string | undefined
  readonly secret: string
  readonly secretEncoding?: StandardWebhookSecretEncoding
  readonly now?: Date
  readonly toleranceSeconds?: number
}): StandardWebhookResult {
  const { rawBody, webhookId, webhookTimestamp, signatureHeader } = input
  if (!webhookId || !webhookTimestamp || !signatureHeader) {
    return { ok: false, reason: 'malformed_header' }
  }

  // Seconds since the epoch, as the spec sends it. Parsed strictly: a header
  // that is not a plain integer is a malformed delivery, not a timestamp of 0 —
  // which would otherwise read as "1970" and fail as out-of-tolerance, telling
  // an operator the wrong thing about a body that never carried a time at all.
  const timestamp = Number(webhookTimestamp.trim())
  if (!Number.isFinite(timestamp) || !/^-?\d+$/u.test(webhookTimestamp.trim())) {
    return { ok: false, reason: 'malformed_header' }
  }

  const signatures = parseSignatureHeader(signatureHeader)
  if (signatures.length === 0) return { ok: false, reason: 'malformed_header' }

  const nowSeconds = Math.floor((input.now?.getTime() ?? Date.now()) / 1000)
  const tolerance = input.toleranceSeconds ?? STANDARD_WEBHOOK_TOLERANCE_SECONDS
  if (Math.abs(nowSeconds - timestamp) > tolerance) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' }
  }

  const expected = createHmac('sha256', hmacKey(input.secret, input.secretEncoding ?? 'base64'))
    .update(`${webhookId}.${webhookTimestamp.trim()}.${rawBody}`)
    .digest()

  const matches = signatures.some((candidate) => safeEqualBase64(candidate, expected))
  return matches ? { ok: true } : { ok: false, reason: 'no_matching_signature' }
}
