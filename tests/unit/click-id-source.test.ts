import {
  ATTRIBUTION_QUERY_KEYS,
  CLICK_ID_SOURCES,
  PII_REDACTED,
  canonicalReferrerHost,
  clickIdSourceOf,
  resolveReferrer,
  sanitizeUrl,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * A paid click stops being Direct (ADR-0075, D-C1 and D-C2).
 *
 * Two properties are pinned here and neither is provable by reading the code:
 *
 * - **Attribution reads the KEY, not the value.** The value is `[redacted]` in
 *   storage and stays that way, so a test that used a short synthetic click id
 *   would pass while production stored nothing usable — which is exactly how the
 *   `order_id` defect reached production. Every case below therefore uses a
 *   realistic click id, long enough to trip the opaque-token rule.
 * - **The exemption is on the key alone.** A genuine secret arriving under the
 *   same key is still destroyed. That is the half a future "make click ids
 *   readable" change would break silently.
 */

const SITE = { siteDomains: ['example.com'] }

/** A real `gclid`: 90-odd characters, mixed alphabet, no spaces. */
const REAL_GCLID = 'EAIaIQobChMIx9-Zt6b0_gIVh4bVCh1sTgyDEAAYASAAEgKq7fD_BwE_padding_padding_padding'

describe('the click-id key list', () => {
  it('is a subset of the keys the redactor preserves', () => {
    // A click id the drop rule removes never reaches the deriver at all, so
    // these two lists are not merely related — one is useless without the other.
    for (const key of Object.keys(CLICK_ID_SOURCES)) {
      expect(ATTRIBUTION_QUERY_KEYS, `${key} must survive the drop rule`).toContain(key)
    }
  })

  it('survives a site that configured the same key as sensitive', () => {
    // This is what the list actually buys, and it is not hypothetical: a site's
    // own `redactQueryKeys` is customer-configured, and a customer who adds
    // `fbclid` to it would otherwise switch their own paid attribution off
    // without ever being told. The attribution list is checked FIRST, so it
    // wins.
    for (const key of Object.keys(CLICK_ID_SOURCES)) {
      const sanitized = sanitizeUrl(`https://example.com/lp?${key}=${REAL_GCLID}`, {
        redactQueryKeys: [key],
      })
      expect(sanitized?.droppedQueryKeys, key).toEqual([])
      expect(clickIdSourceOf(sanitized)?.key, key).toBe(key)
    }
  })

  it('maps every platform to a host spelled the way every other row spells it', () => {
    // `referrer_domain` is a rollup grouping key (ADR-0028): a second spelling
    // of one host splits one source into two rows no reader can merge back, and
    // the rollups are additive and never rewritten.
    for (const host of Object.values(CLICK_ID_SOURCES)) {
      expect(canonicalReferrerHost(host), host).toBe(host)
    }
  })
})

describe('deriving a source from a click id', () => {
  it('derives the platform from a click id whose value is already redacted', () => {
    // The property the whole feature rests on. Prove the premise first: a real
    // click id IS destroyed by the redactor.
    const sanitized = sanitizeUrl(`https://example.com/lp?gclid=${REAL_GCLID}`)
    expect(sanitized?.query['gclid']).toBe(PII_REDACTED)

    // And it is still attributable, because presence is the signal.
    expect(clickIdSourceOf(sanitized)).toEqual({ domain: 'google.com', key: 'gclid' })
  })

  it('derives from every platform in the map', () => {
    for (const [key, host] of Object.entries(CLICK_ID_SOURCES)) {
      const sanitized = sanitizeUrl(`https://example.com/lp?${key}=${REAL_GCLID}`)
      expect(clickIdSourceOf(sanitized), key).toEqual({ domain: host, key })
    }
  })

  it('picks one platform deterministically when a URL carries two', () => {
    // A stitched-together link is one click, not two, and two identical URLs
    // must attribute identically or one source becomes two rollup rows.
    const both = sanitizeUrl(`https://example.com/lp?fbclid=${REAL_GCLID}&gclid=${REAL_GCLID}`)
    const reversed = sanitizeUrl(`https://example.com/lp?gclid=${REAL_GCLID}&fbclid=${REAL_GCLID}`)
    expect(clickIdSourceOf(both)).toEqual(clickIdSourceOf(reversed))
    expect(clickIdSourceOf(both)?.key).toBe('gclid')
  })

  it('ignores an empty click id', () => {
    // `?gclid=` is what a broken link template leaves behind. Inferring a paid
    // source from it would move real Direct traffic into a channel the customer
    // is being billed for.
    expect(clickIdSourceOf(sanitizeUrl('https://example.com/lp?gclid='))).toBeNull()
  })

  it('matches a re-cased key', () => {
    const sanitized = sanitizeUrl(`https://example.com/lp?FBCLID=${REAL_GCLID}`)
    expect(clickIdSourceOf(sanitized)?.domain).toBe('facebook.com')
  })

  it('derives nothing from a landing URL with no click id', () => {
    expect(clickIdSourceOf(sanitizeUrl('https://example.com/lp?utm_source=news'))).toBeNull()
    expect(clickIdSourceOf(null)).toBeNull()
  })
})

describe('what the exemption does NOT open', () => {
  it('still destroys a real secret arriving under a click-id key', () => {
    // D-C2's boundary. The key survives the DROP rule; the value is still run
    // through every explicit rule, so a Stripe key pasted into a `gclid` — a
    // mistake, a probe, or a badly built redirect — is not stored.
    const sanitized = sanitizeUrl('https://example.com/lp?gclid=sk_live_51H8xQzAbCdEfGhIjKlMnOp')
    expect(sanitized?.query['gclid']).toBe(PII_REDACTED)
    expect(sanitized?.url).not.toContain('sk_live')

    // And attribution still works, which is the point: it never needed the value.
    expect(clickIdSourceOf(sanitized)?.domain).toBe('google.com')
  })

  it('never carries a click-id value into the stored URL', () => {
    const sanitized = sanitizeUrl(`https://example.com/lp?gclid=${REAL_GCLID}`)
    expect(sanitized?.url).not.toContain(REAL_GCLID)
  })
})

describe('the guard a stale click id must not get past', () => {
  it('leaves an internal navigation Direct even when the URL kept an fbclid', () => {
    // A visitor lands from an ad and clicks through to a second page whose link
    // kept the parameter. That is not a new acquisition, and `isSelf` says so —
    // the collector only fills a referrer that resolved to NOTHING.
    const referrer = resolveReferrer('https://example.com/lp', {
      ...SITE,
      pageUrl: 'https://example.com/pricing',
    })
    expect(referrer.domain).toBeNull()
    expect(referrer.isSelf).toBe(true)

    const page = sanitizeUrl(`https://example.com/pricing?fbclid=${REAL_GCLID}`)
    // The click id is still there and still derivable in isolation…
    expect(clickIdSourceOf(page)?.domain).toBe('facebook.com')
    // …and the collector's condition — `domain === null && !isSelf` — is false,
    // so this event stays Direct. The condition is asserted rather than the
    // outcome because it is the line that decides.
    expect(referrer.domain === null && !referrer.isSelf).toBe(false)
  })

  it('does not override a referrer the browser actually sent', () => {
    const referrer = resolveReferrer('https://news.ycombinator.com/item?id=1', {
      ...SITE,
      pageUrl: 'https://example.com/lp',
    })
    expect(referrer.domain).toBe('news.ycombinator.com')
    expect(referrer.domain === null && !referrer.isSelf).toBe(false)
  })
})
