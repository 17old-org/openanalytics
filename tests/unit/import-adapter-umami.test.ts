import {
  CITY_DROPPED_WARNING,
  DIMENSION_TRUNCATED_WARNING,
  DUPLICATE_EVENTS_WARNING,
  IMPORT_DIMENSION_MAX_BYTES,
  IMPORT_TRUNCATION_SENTINEL,
  ImportRunFailure,
  UMAMI_MAX_STATE_ENTRIES,
  UMAMI_PROVIDER_ID,
  UMAMI_RECORD_INCOMPLETE,
  UMAMI_RECORD_MALFORMED,
  UNKNOWN_COLUMN_WARNING,
  parseUmamiCsvRecord,
  umamiImportAdapter,
  type ImportRowBatch,
  type ImportedReport,
  type ImportedRow,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'
import {
  UMAMI_COLUMNS,
  UMAMI_EVENT_CSV,
  UMAMI_EVENT_ROWS,
  umamiCsv,
  umamiRow,
  type UmamiColumn,
  type UmamiEvent,
} from '../support/import-fixtures.ts'

/**
 * The Umami adapter (ADR-0032, D2/D11 and its Umami amendment).
 *
 * The Plausible suite is organised around the three things a *column mapper* can
 * get wrong. This adapter is not a column mapper — it is an aggregator — so it
 * has a fourth failure mode, and it is the one that would hurt most: **the
 * numbers can be arithmetically wrong while every row parses perfectly.** A
 * customer's only signal would be totals that disagree with the dashboard they
 * are migrating off, discovered after publishing.
 *
 * So the suite is:
 *
 * 1. **Which file is which**, and that one file legitimately claims eight
 *    reports.
 * 2. **Which column is which** — Umami's exact column order is not a contract
 *    and a positional reader that is right today is wrong the day it moves.
 * 3. **What the numbers are**, checked against Umami's own definitions on a
 *    fixture small enough to compute by hand.
 * 4. **What is dropped, and whether anyone is told** — the city, the duplicate
 *    rows, the truncated values.
 */

const adapter = umamiImportAdapter
const ENTRY = 'website_event.csv'

async function* lines(text: string): AsyncIterable<string> {
  // Exactly what the pipeline does: frame on `\n`, which is what splits a
  // quoted field containing a newline across two of them.
  for (const line of text.split('\n')) yield line
}

async function parse<R extends ImportedReport>(
  report: R,
  text: string = UMAMI_EVENT_CSV,
  options: { entryName?: string } = {},
): Promise<{ rows: ImportedRow<R>[]; warnings: Map<string, number> }> {
  const rows: ImportedRow<R>[] = []
  const warnings = new Map<string, number>()
  const batches = adapter.parseEntry<R>({
    report,
    entryName: options.entryName ?? ENTRY,
    lines: lines(text),
  })
  for await (const batch of batches as AsyncIterable<ImportRowBatch<R>>) {
    rows.push(...batch.rows)
    for (const warning of batch.warnings ?? []) {
      warnings.set(warning.code, (warnings.get(warning.code) ?? 0) + warning.count)
    }
  }
  return { rows, warnings }
}

/** A one-row export, for asserting a single value without the fixture's shape
 * getting in the way. Every unnamed column defaults to empty. */
function oneRow(event: UmamiEvent): string {
  return umamiCsv([
    umamiRow({
      session_id: 's-1',
      visit_id: 'v-1',
      url_path: '/',
      created_at: '2026-03-01 10:00:00',
      ...event,
    }),
  ])
}

describe('entry recognition', () => {
  it('claims the event table under all eight reports, from one entry', () => {
    // The whole shape of this provider: one event-level file that every staged
    // report is aggregated from, rather than one file per report.
    expect(adapter.providerId).toBe(UMAMI_PROVIDER_ID)
    expect(adapter.reports()).toHaveLength(8)
    expect([...(adapter.reportsForEntry?.(ENTRY) ?? [])].sort()).toEqual([
      'browsers',
      'custom_events',
      'devices',
      'geography',
      'metrics',
      'os',
      'pages',
      'sources',
    ])
    for (const report of adapter.reports()) {
      expect(adapter.expectedEntryPattern(report).test(ENTRY), report).toBe(true)
    }
  })

  it('keeps reportForEntry consistent with the list, for a caller that knows only it', () => {
    // The two answer the same question and the contract says a caller is
    // entitled to either.
    expect(adapter.reportForEntry(ENTRY)).toBe(adapter.reportsForEntry?.(ENTRY)?.[0])
    expect(adapter.reportForEntry('session_data.csv')).toBeNull()
    expect(adapter.reportsForEntry?.('session_data.csv')).toEqual([])
  })

  it('recognises the two property-bag files as declared drops', () => {
    // Without the dropped pattern an ordinary Cloud export would fail
    // `unexpected_entry` and the customer would be told their archive is the
    // wrong provider's.
    const dropped = adapter.droppedEntryPattern()
    expect(dropped?.test('session_data.csv')).toBe(true)
    expect(dropped?.test('event_data.csv')).toBe(true)
    expect(dropped?.test(ENTRY)).toBe(false)
    // The token, never the filename: it reaches the customer's review screen.
    expect(adapter.droppedEntryToken?.('session_data.csv')).toBe('session_data')
    expect(adapter.droppedEntryToken?.('event_data.csv')).toBe('event_data')
  })

  it('refuses an entry name that is not this provider’s', () => {
    expect(adapter.reportForEntry('imported_pages_20240101_20240103.csv')).toBeNull()
    expect(adapter.reportForEntry('../website_event.csv')).toBeNull()
    expect(adapter.reportForEntry('website_event.csv.gz')).toBeNull()
    // A re-zipped export whose member picked up a suffix is still the event
    // table: the pattern is anchored on the prefix and loose on the tail.
    expect(adapter.reportForEntry('website_event_2026.csv')).toBe(adapter.reports()[0])
  })
})

describe('CSV records', () => {
  it('keeps a quoted comma inside one field', () => {
    expect(parseUmamiCsvRecord('a,"b,c",d')).toEqual(['a', 'b,c', 'd'])
  })

  it('unescapes a doubled quote', () => {
    expect(parseUmamiCsvRecord('"say ""hi""",2')).toEqual(['say "hi"', '2'])
  })

  it('keeps empty trailing and interior fields', () => {
    expect(parseUmamiCsvRecord('a,,c,')).toEqual(['a', '', 'c', ''])
  })

  it('reports an unterminated quoted field as incomplete, not as a failure', () => {
    // The one place this reader differs from Plausible's, and the whole reason
    // it does: the rest of the record is on the next line.
    expect(parseUmamiCsvRecord('a,"b,c')).toBe(UMAMI_RECORD_INCOMPLETE)
  })

  it('still refuses the records it would have to guess at', () => {
    // Garbage directly after a closing quote, and a quote that opens after
    // leading whitespace — ` "a,b",c` is three cells read strictly and four read
    // leniently, and the two disagree about where every later value goes.
    expect(parseUmamiCsvRecord('"a"x,b')).toBe(UMAMI_RECORD_MALFORMED)
    expect(parseUmamiCsvRecord(' "a,b",c')).toBe(UMAMI_RECORD_MALFORMED)
    expect(parseUmamiCsvRecord('x, "a,b"')).toBe(UMAMI_RECORD_MALFORMED)
    // A quote genuinely part of an unquoted value is still fine.
    expect(parseUmamiCsvRecord('5" screen,2')).toEqual(['5" screen', '2'])
  })
})

describe('record stitching', () => {
  it('reassembles a record whose page title contains a newline', async () => {
    // Umami never strips `\n` from `page_title`: the tracker sends
    // `document.title` verbatim and the server truncates at 500 characters and
    // nothing else. The pipeline frames *lines*, so this record arrives in two
    // pieces — and a reader that refused it would fail a perfectly ordinary
    // export of a site whose title wrapped.
    const { rows } = await parse('metrics')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ date: '2026-03-01', pageviews: 3 })
  })

  it('carries the stitched value through, newline and all', async () => {
    // The title is not a staged dimension, so the proof is a *page path* split
    // the same way: the scrubber then collapses the newline to a space, which is
    // what it does to every control character.
    const text = umamiCsv([
      umamiRow({
        session_id: 's-1',
        visit_id: 'v-1',
        hostname: 'shop.example.com',
        url_path: '/a\nb',
        created_at: '2026-03-01 10:00:00',
      }),
    ])
    const { rows } = await parse('pages', text)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.page).toBe('/a b')
  })

  it('fails a record that never closes its quote before the entry ends', async () => {
    const text = [
      UMAMI_COLUMNS.map((column) => `"${column}"`).join(','),
      '"a","b","c","never closed',
    ].join('\n')
    const error = (await parse('metrics', text).catch((e: unknown) => e)) as ImportRunFailure
    expect(error).toBeInstanceOf(ImportRunFailure)
    expect(error.category).toBe('malformed_csv')
  })

  it('bounds how much it will stitch', async () => {
    // A malformed quote near the top of a large entry would otherwise
    // concatenate the whole file into one string before failing.
    const text = [
      UMAMI_COLUMNS.map((column) => `"${column}"`).join(','),
      '"a","b","c","never closed',
      ...Array.from({ length: 200 }, () => 'more text with no closing quote'),
    ].join('\n')
    await expect(parse('metrics', text)).rejects.toThrow(ImportRunFailure)
  })
})

describe('column mapping', () => {
  it('is indifferent to column order', async () => {
    // The exact Cloud column order is not a contract. A positional reader that
    // is right today is wrong the day a column moves, with every value shifted
    // one place and no error anywhere.
    const reversed = [...UMAMI_COLUMNS].reverse()
    const cell = (event: UmamiEvent, column: UmamiColumn): string =>
      column === 'event_type' ? (event.event_type ?? '1') : `"${event[column] ?? ''}"`
    const event: UmamiEvent = {
      session_id: 's-1',
      visit_id: 'v-1',
      device: 'mobile',
      created_at: '2026-03-01 10:00:00',
    }
    const text = [
      reversed.map((column) => `"${column}"`).join(','),
      reversed.map((column) => cell(event, column)).join(','),
    ].join('\n')
    const { rows } = await parse('devices', text)
    expect(rows[0]).toMatchObject({ date: '2026-03-01', device: 'mobile', pageviews: 1 })
  })

  it('ignores an unknown extra column and counts it once for the whole entry', async () => {
    // Eight passes read one file, so a warning about the *file* emitted from
    // every pass would show the customer a count eight times too large.
    const text = [
      `${UMAMI_COLUMNS.map((column) => `"${column}"`).join(',')},"experimental"`,
      `${umamiRow({
        session_id: 's-1',
        visit_id: 'v-1',
        created_at: '2026-03-01 10:00:00',
      })},"999"`,
    ].join('\n')
    const metrics = await parse('metrics', text)
    expect(metrics.rows[0]).toMatchObject({ pageviews: 1 })
    expect(metrics.warnings.get(UNKNOWN_COLUMN_WARNING)).toBe(1)
    // Every other pass sees the same column and says nothing about it.
    expect((await parse('pages', text)).warnings.has(UNKNOWN_COLUMN_WARNING)).toBe(false)
    expect((await parse('devices', text)).warnings.has(UNKNOWN_COLUMN_WARNING)).toBe(false)
  })

  it('fails the entry when a required column is missing', async () => {
    // Four columns, and without any of them the report would stage numbers that
    // look like measurements and are not.
    for (const missing of ['session_id', 'visit_id', 'created_at', 'event_type']) {
      const kept = UMAMI_COLUMNS.filter((column) => column !== missing)
      const text = [
        kept.map((column) => `"${column}"`).join(','),
        kept.map(() => '""').join(','),
      ].join('\n')
      await expect(parse('metrics', text), missing).rejects.toThrow(ImportRunFailure)
    }
  })

  it('fails a header that repeats a column name', async () => {
    const text = [
      `${UMAMI_COLUMNS.map((column) => `"${column}"`).join(',')},"country"`,
      `${umamiRow({ session_id: 's', visit_id: 'v', created_at: '2026-03-01 10:00:00' })},"GB"`,
    ].join('\n')
    await expect(parse('geography', text)).rejects.toThrow(ImportRunFailure)
  })

  it('reads the pre-2.18 subdivision1 as region', async () => {
    // An export taken before Umami renamed the column is a legitimate export,
    // and losing the dimension silently is the failure mode.
    const columns = UMAMI_COLUMNS.map((column) => (column === 'region' ? 'subdivision1' : column))
    const text = [
      columns.map((column) => `"${column}"`).join(','),
      columns
        .map((column) => {
          if (column === 'event_type') return '1'
          if (column === 'session_id') return '"s-1"'
          if (column === 'visit_id') return '"v-1"'
          if (column === 'created_at') return '"2026-03-01 10:00:00"'
          if (column === 'country') return '"US"'
          if (column === 'subdivision1') return '"US-CA"'
          return '""'
        })
        .join(','),
    ].join('\n')
    const { rows, warnings } = await parse('geography', text)
    expect(rows[0]).toMatchObject({ country: 'US', region: 'US-CA' })
    // And it is a *known* spelling, not an unknown column.
    expect(warnings.has(UNKNOWN_COLUMN_WARNING)).toBe(false)
  })

  it('reads the NULL literal and the empty string as the same absence', async () => {
    // A Cloud export writes an unquoted `\N` in its nullable columns, and a
    // `COPY ... TO CSV` from a self-hosted database writes one anywhere.
    const { rows } = await parse('geography', oneRow({ country: '\\N', region: '\\N' }))
    expect(rows[0]).toMatchObject({ country: '', region: '' })
  })
})

describe('the live vocabulary', () => {
  const one = async <R extends ImportedReport>(
    report: R,
    event: UmamiEvent,
  ): Promise<ImportedRow<R> | undefined> => (await parse(report, oneRow(event))).rows[0]

  it('translates device classes into the four the live classifier emits', async () => {
    expect((await one('devices', { device: 'desktop' }))?.device).toBe('desktop')
    expect((await one('devices', { device: 'laptop' }))?.device).toBe('desktop')
    expect((await one('devices', { device: 'mobile' }))?.device).toBe('mobile')
    expect((await one('devices', { device: 'tablet' }))?.device).toBe('tablet')
    // The live classifier cannot produce a fifth value, so a console or a
    // smart TV has no live row to merge with and belongs in `unknown` rather
    // than as a category only imported ranges can ever show.
    for (const exotic of ['console', 'smarttv', 'wearable', 'xr', 'embedded', '']) {
      expect((await one('devices', { device: exotic }))?.device, exotic).toBe('unknown')
    }
  })

  it('translates detect-browser ids onto the live BROWSER_RULES tokens', async () => {
    // Umami stores what `detect-browser` returns — an id, not a display name —
    // so `ios` here means Safari on iPhone and `crios` means Chrome.
    const pairs: [string, string][] = [
      ['chrome', 'chrome'],
      ['crios', 'chrome'],
      ['chromium-webview', 'chrome'],
      ['edge-chromium', 'edge'],
      ['edge-ios', 'edge'],
      ['fxios', 'firefox'],
      ['ios', 'safari'],
      ['ios-webview', 'safari'],
      ['opera-mini', 'opera'],
      ['samsung', 'samsung'],
    ]
    for (const [provider, token] of pairs) {
      expect((await one('browsers', { browser: provider }))?.browser, provider).toBe(token)
    }
    // An unmapped browser is still a real browser: lowercased, not `unknown`,
    // which would merge it with the genuinely unresolvable rows.
    expect((await one('browsers', { browser: 'Vivaldi' }))?.browser).toBe('vivaldi')
    expect((await one('browsers', { browser: '' }))?.browser).toBe('unknown')
    // Umami has no version column, so nothing is invented for one.
    expect((await one('browsers', { browser: 'chrome' }))?.browserVersion).toBe('')
  })

  it('folds every desktop Windows onto one token and leaves Windows Mobile alone', async () => {
    for (const windows of ['Windows 10', 'Windows 7', 'Windows XP', 'Windows Server 2003']) {
      expect((await one('os', { os: windows }))?.operatingSystem, windows).toBe('windows')
    }
    // **Not** `windows`. Windows Mobile is a different device class, and folding
    // it into the desktop token would put phone traffic into a Windows row.
    expect((await one('os', { os: 'Windows Mobile' }))?.operatingSystem).toBe('windows mobile')
    expect((await one('os', { os: 'Mac OS' }))?.operatingSystem).toBe('macos')
    expect((await one('os', { os: 'iOS' }))?.operatingSystem).toBe('ios')
    expect((await one('os', { os: 'Android OS' }))?.operatingSystem).toBe('android')
    expect((await one('os', { os: 'Chrome OS' }))?.operatingSystem).toBe('chromeos')
    expect((await one('os', { os: 'Linux' }))?.operatingSystem).toBe('linux')
    expect((await one('os', { os: '' }))?.operatingSystem).toBe('unknown')
    expect((await one('os', { os: 'Mac OS' }))?.osVersion).toBe('')
  })

  it('normalises the country to ISO-2 and blanks a placeholder', async () => {
    expect((await one('geography', { country: 'gb' }))?.country).toBe('GB')
    for (const placeholder of ['XX', 'T1', 'GBR', '']) {
      expect((await one('geography', { country: placeholder }))?.country, placeholder).toBe('')
    }
  })

  it('canonicalises the referrer host the way the live referrer path does', async () => {
    // `www.google.com` and `google.com` are one acquisition source, and merging
    // them is the whole reason the live path has a canonicaliser. Umami has
    // usually stripped the `www.` already; the canonicaliser is idempotent.
    expect((await one('sources', { referrer_domain: 'WWW.Google.com:443' }))?.referrer).toBe(
      'google.com',
    )
    // Umami blanks a self-referral, and direct traffic stays empty on both sides.
    expect((await one('sources', { referrer_domain: '' }))?.referrer).toBe('')
  })

  it('derives `source` from the UTM tag, else the referring host, else nothing', async () => {
    // Umami has no resolved-channel column, and the live imported-sources
    // operation reads `referrer` and the UTM triple — never `source` — so this
    // value is derived from two fields already in the key and adds no
    // cardinality of its own.
    expect(
      (await one('sources', { utm_source: 'newsletter', referrer_domain: 'news.example.com' }))
        ?.source,
    ).toBe('newsletter')
    expect((await one('sources', { referrer_domain: 'www.news.example.com' }))?.source).toBe(
      'news.example.com',
    )
    expect((await one('sources', {}))?.source).toBe('')
  })
})

describe('Umami’s own metric definitions', () => {
  it('computes the daily totals the provider’s dashboard shows', async () => {
    // Hand-computed from the fixture: see its table. The parity that matters is
    // with Umami, not with this system's sessionizer — a customer checks the
    // import against the dashboard they are migrating off.
    const { rows } = await parse('metrics')
    expect(rows).toEqual([
      { date: '2026-03-01', visitors: 2, visits: 2, pageviews: 3, bounces: 1, visitDuration: 30 },
      { date: '2026-03-02', visitors: 1, visits: 1, pageviews: 2, bounces: 0, visitDuration: 20 },
    ])
  })

  it('counts a bounce as one pageview and no custom event', async () => {
    const view = (at: string, type = '1', name = ''): string =>
      umamiRow({
        session_id: 's-1',
        visit_id: 'v-1',
        url_path: '/',
        event_type: type,
        event_name: name,
        created_at: at,
      })
    // One pageview alone: a bounce.
    expect((await parse('metrics', umamiCsv([view('2026-03-01 10:00:00')]))).rows[0]).toMatchObject(
      { visits: 1, bounces: 1 },
    )
    // One pageview and a custom event in the same visit: not a bounce, which is
    // the v3 rule and the one place this differs from the older `count = 1`.
    expect(
      (
        await parse(
          'metrics',
          umamiCsv([view('2026-03-01 10:00:00'), view('2026-03-01 10:00:05', '2', 'Signup')]),
        )
      ).rows[0],
    ).toMatchObject({ visits: 1, bounces: 0, pageviews: 1 })
    // Two pageviews: not a bounce either.
    expect(
      (await parse('metrics', umamiCsv([view('2026-03-01 10:00:00'), view('2026-03-01 10:00:09')])))
        .rows[0],
    ).toMatchObject({ visits: 1, bounces: 0, pageviews: 2, visitDuration: 9 })
  })

  it('excludes a visit whose only row that day is a custom event', async () => {
    // Their `group by` runs over pageview rows, so such a visit produces no
    // group at all — it is not a visit, not a bounce and contributes no time.
    const { rows } = await parse('metrics')
    // The fixture's second day carries exactly that visit.
    expect(rows[1]).toMatchObject({ visits: 1, visitors: 1 })
  })

  it('does not stage a breakdown row for a dimension only a custom event named', async () => {
    // Unsorted input forces a bucket into existence the moment a custom event
    // names its dimensions. If no pageview ever joins it, every measure it could
    // report is zero, and staging it would put a row on a breakdown that says a
    // dimension was seen and then reports nothing about it.
    const second = <T extends { date: string }>(rows: readonly T[]): readonly T[] =>
      rows.filter((row) => row.date === '2026-03-02')
    expect(second((await parse('devices')).rows).map((row) => row.device)).toEqual(['tablet'])
    expect(second((await parse('os')).rows).map((row) => row.operatingSystem)).toEqual(['macos'])
    expect(second((await parse('geography')).rows).map((row) => row.country)).toEqual([''])
  })

  it('counts a visit that spans midnight in each day it touches', async () => {
    const across = umamiCsv([
      umamiRow({
        session_id: 's-1',
        visit_id: 'v-1',
        url_path: '/',
        created_at: '2026-03-01 23:59:50',
      }),
      umamiRow({
        session_id: 's-1',
        visit_id: 'v-1',
        url_path: '/',
        created_at: '2026-03-02 00:00:10',
      }),
    ])
    const { rows } = await parse('metrics', across)
    // Two days, each with one visitor and one visit — the same visit — and
    // neither carrying the twenty seconds that elapsed between them. That is
    // what Umami's own daily charts show, and matching it is the point.
    expect(rows).toEqual([
      { date: '2026-03-01', visitors: 1, visits: 1, pageviews: 1, bounces: 1, visitDuration: 0 },
      { date: '2026-03-02', visitors: 1, visits: 1, pageviews: 1, bounces: 1, visitDuration: 0 },
    ])
  })

  it('counts link and pixel rows as pageviews and performance rows as nothing', async () => {
    // v3 added event types 3, 4 and 5. Their stats query excludes 2 and 5, which
    // means 3 and 4 count — so this adapter does too, whether or not a website
    // export ever carries one.
    const rows = (type: string): string =>
      umamiCsv([
        umamiRow({
          session_id: 's-1',
          visit_id: 'v-1',
          url_path: '/',
          event_type: type,
          created_at: '2026-03-01 10:00:00',
        }),
      ])
    expect((await parse('metrics', rows('3'))).rows[0]).toMatchObject({ pageviews: 1 })
    expect((await parse('metrics', rows('4'))).rows[0]).toMatchObject({ pageviews: 1 })
    // A performance row changes no measure, so its day has nothing to stage.
    expect((await parse('metrics', rows('5'))).rows).toEqual([])
  })

  it('is indifferent to the order the rows arrive in', async () => {
    // No source promises an export is sorted, so a pass accumulates every day at
    // once and emits at the end. Reversing the file must change nothing.
    const forward = await parse('metrics')
    const backward = await parse('metrics', umamiCsv([...UMAMI_EVENT_ROWS].reverse()))
    expect(backward.rows).toEqual(forward.rows)
    expect(backward.warnings).toEqual(forward.warnings)
  })

  it('emits days and dimensions in a fixed order whatever the file’s', async () => {
    // The resume path re-parses from the start and skips the chunks already
    // recorded, which is only correct if chunk N of report R holds the same rows
    // on every attempt.
    const forward = await parse('geography')
    const backward = await parse('geography', umamiCsv([...UMAMI_EVENT_ROWS].reverse()))
    expect(forward.rows.map((row) => [row.date, row.country])).toEqual([
      ['2026-03-01', 'DE'],
      ['2026-03-01', 'GB'],
      ['2026-03-02', ''],
    ])
    expect(backward.rows).toEqual(forward.rows)
  })
})

describe('duplicate events', () => {
  it('drops a repeated event_id and counts it once for the whole entry', async () => {
    // A community importer dedupes on `event_id`, which is the only evidence
    // that duplicates happen; the fixture repeats one row verbatim, out of
    // place. Undropped it would add a pageview to a day and a second slice to a
    // visit — a number nobody measured.
    const metrics = await parse('metrics')
    expect(metrics.rows[0]).toMatchObject({ pageviews: 3 })
    expect(metrics.warnings.get(DUPLICATE_EVENTS_WARNING)).toBe(1)
    // The drop happens identically in every pass — the count would otherwise
    // disagree with itself eight times — but only one pass reports it.
    expect((await parse('pages')).warnings.has(DUPLICATE_EVENTS_WARNING)).toBe(false)
    const pages = (await parse('pages')).rows.filter((row) => row.page === '/pricing')
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ pageviews: 1 })
  })

  it('never dedupes rows that carry no event_id', async () => {
    // Every such row would otherwise collapse into one.
    const text = umamiCsv([
      umamiRow({ session_id: 's-1', visit_id: 'v-1', created_at: '2026-03-01 10:00:00' }),
      umamiRow({ session_id: 's-1', visit_id: 'v-1', created_at: '2026-03-01 10:00:10' }),
    ])
    const { rows, warnings } = await parse('metrics', text)
    expect(rows[0]).toMatchObject({ pageviews: 2 })
    expect(warnings.has(DUPLICATE_EVENTS_WARNING)).toBe(false)
  })
})

describe('the per-report mappings', () => {
  it('stages pages by hostname and path, from pageview rows only', async () => {
    const { rows } = await parse('pages')
    expect(rows).toEqual([
      {
        date: '2026-03-01',
        hostname: 'shop.example.com',
        page: '/',
        visitors: 2,
        visits: 2,
        pageviews: 2,
      },
      {
        date: '2026-03-01',
        hostname: 'shop.example.com',
        page: '/pricing',
        visitors: 1,
        visits: 1,
        pageviews: 1,
      },
      {
        date: '2026-03-02',
        hostname: 'docs.example.com',
        page: '/',
        visitors: 1,
        visits: 1,
        pageviews: 2,
      },
    ])
  })

  it('stages sources on the referrer and the UTM tuple, quoted comma and all', async () => {
    const { rows } = await parse('sources')
    expect(rows[0]).toEqual({
      date: '2026-03-01',
      source: 'example.net',
      referrer: 'example.net',
      utmSource: '',
      utmMedium: '',
      utmCampaign: '',
      utmContent: '',
      utmTerm: '',
      visitors: 1,
      visits: 1,
      pageviews: 2,
      bounces: 0,
      visitDuration: 30,
    })
    expect(rows[1]).toEqual({
      date: '2026-03-01',
      source: 'newsletter',
      referrer: '',
      utmSource: 'newsletter',
      utmMedium: 'email',
      utmCampaign: 'spring, 2026',
      utmContent: '',
      utmTerm: '',
      visitors: 1,
      visits: 1,
      pageviews: 1,
      bounces: 1,
      visitDuration: 0,
    })
  })

  it('stages geography as country and region, and never a city', async () => {
    const { rows, warnings } = await parse('geography')
    expect(rows[1]).toEqual({
      date: '2026-03-01',
      country: 'GB',
      region: 'GB-ENG',
      visitors: 1,
      visits: 1,
      pageviews: 2,
      bounces: 0,
      visitDuration: 30,
    })
    // Umami ships a city *name* rather than Plausible's GeoNames id, and it is
    // dropped all the same: the staged table has no city column (D2). The count
    // is what tells the reviewer whether the loss matters for their site.
    expect(warnings.get(CITY_DROPPED_WARNING)).toBe(4)
    // No row carries a city key at all, not even an empty one.
    for (const row of rows) expect(Object.keys(row)).not.toContain('city')
  })

  it('says nothing about cities when the export carried none', async () => {
    const { warnings } = await parse('geography', oneRow({ country: 'GB', city: '' }))
    expect(warnings.has(CITY_DROPPED_WARNING)).toBe(false)
  })

  it('stages custom events by name, with no goal properties invented', async () => {
    const { rows } = await parse('custom_events')
    expect(rows).toEqual([
      { date: '2026-03-01', name: 'Signup', linkUrl: '', path: '', visitors: 1, events: 1 },
      { date: '2026-03-02', name: 'Signup', linkUrl: '', path: '', visitors: 1, events: 1 },
    ])
  })

  it('stages devices, browsers and operating systems with their measures', async () => {
    expect((await parse('devices')).rows).toEqual([
      {
        date: '2026-03-01',
        device: 'desktop',
        visitors: 1,
        visits: 1,
        pageviews: 2,
        bounces: 0,
        visitDuration: 30,
      },
      {
        date: '2026-03-01',
        device: 'mobile',
        visitors: 1,
        visits: 1,
        pageviews: 1,
        bounces: 1,
        visitDuration: 0,
      },
      {
        date: '2026-03-02',
        device: 'tablet',
        visitors: 1,
        visits: 1,
        pageviews: 2,
        bounces: 0,
        visitDuration: 20,
      },
    ])
    expect((await parse('browsers')).rows.map((row) => row.browser)).toEqual([
      'chrome',
      'safari',
      'chrome',
    ])
    expect((await parse('os')).rows.map((row) => row.operatingSystem)).toEqual([
      'ios',
      'windows',
      'macos',
    ])
  })
})

describe('row shape and values', () => {
  it('refuses a row that is not exactly as wide as the header', async () => {
    const short = [UMAMI_COLUMNS.map((column) => `"${column}"`).join(','), '"a","b","c"'].join('\n')
    const long = [
      UMAMI_COLUMNS.map((column) => `"${column}"`).join(','),
      `${umamiRow({ session_id: 's', visit_id: 'v', created_at: '2026-03-01 10:00:00' })},"extra"`,
    ].join('\n')
    await expect(parse('metrics', short)).rejects.toThrow(ImportRunFailure)
    await expect(parse('metrics', long)).rejects.toThrow(ImportRunFailure)
  })

  it('reports the report and the line, never the row’s content', async () => {
    // The detail is logged beside a customer-visible category. A hostile CSV
    // must not be able to write its own text into either.
    const text = oneRow({ created_at: '<script>alert(1)</script>' })
    const error = (await parse('metrics', text).catch((e: unknown) => e)) as ImportRunFailure
    expect(error).toBeInstanceOf(ImportRunFailure)
    expect(error.category).toBe('malformed_csv')
    expect(error.detail).toEqual({ report: 'metrics', line: 2 })
    expect(JSON.stringify(error.detail)).not.toContain('script')
  })

  it('refuses a created_at that is not a UTC calendar instant', async () => {
    for (const bad of [
      '',
      '2026-03-01',
      '2026-02-31 10:00:00',
      '2026-13-01 10:00:00',
      'yesterday',
      // A non-UTC offset is refused rather than converted: guessing at it would
      // shift a whole day's rows.
      '2026-03-01 10:00:00+02:00',
    ]) {
      await expect(parse('metrics', oneRow({ created_at: bad })), bad).rejects.toThrow(
        ImportRunFailure,
      )
    }
    // The ISO spellings a self-hosted database dump produces are accepted.
    for (const good of ['2026-03-01T10:00:00', '2026-03-01T10:00:00Z', '2026-03-01 10:00:00.123']) {
      expect((await parse('metrics', oneRow({ created_at: good }))).rows[0]?.date, good).toBe(
        '2026-03-01',
      )
    }
  })

  it('refuses an event_type that is not an integer', async () => {
    for (const bad of ['', '1.5', 'pageview', '1e0', '0x1']) {
      await expect(parse('metrics', oneRow({ event_type: bad })), bad).rejects.toThrow(
        ImportRunFailure,
      )
    }
  })

  it('refuses a row with no session or visit identity', async () => {
    // Both are NOT NULL in every Umami schema, and a blank one cannot be given
    // an identity here: every blank would merge into a single visitor and the
    // export would silently understate exactly the number a migration is
    // checked against.
    await expect(parse('metrics', oneRow({ session_id: '' }))).rejects.toThrow(ImportRunFailure)
    await expect(parse('metrics', oneRow({ visit_id: '' }))).rejects.toThrow(ImportRunFailure)
  })

  it('scrubs a dimension value rather than storing it raw', async () => {
    const text = oneRow({ url_path: `/a${String.fromCharCode(7)}b   c`, hostname: 'shop.test' })
    expect((await parse('pages', text)).rows[0]?.page).toBe('/a b c')
  })

  it('counts truncated dimensions with the same ceremony as the dropped city', async () => {
    // Umami caps a path at 500 characters, so this is not reachable through the
    // product — and the cap is a byte budget a four-byte code point can still
    // exceed, which is exactly why it is enforced here rather than assumed.
    const text = oneRow({ url_path: `/${'é'.repeat(400)}`, hostname: 'shop.test' })
    const { rows, warnings } = await parse('pages', text)
    expect(warnings.get(DIMENSION_TRUNCATED_WARNING)).toBe(1)
    expect(rows[0]?.page.endsWith(IMPORT_TRUNCATION_SENTINEL)).toBe(true)
    expect(Buffer.byteLength(rows[0]?.page ?? '', 'utf8')).toBeLessThanOrEqual(
      IMPORT_DIMENSION_MAX_BYTES,
    )
  })

  it('refuses an entry with no header at all, and says so accurately', async () => {
    for (const empty of ['', '\n', '\n   \n\n']) {
      const error = (await parse('metrics', empty).catch((e: unknown) => e)) as ImportRunFailure
      expect(error, JSON.stringify(empty)).toBeInstanceOf(ImportRunFailure)
      expect(error.message).toContain('empty')
    }
  })

  it('accepts a header-only export and stages nothing', async () => {
    // A site that recorded nothing in the exported range is not a broken export.
    const { rows } = await parse('metrics', umamiCsv([]))
    expect(rows).toEqual([])
  })
})

describe('the aggregation bound', () => {
  it('fails honestly rather than growing without limit', async () => {
    // The state is one entry per row for the dedup set alone, on a worker with a
    // 768 MB container and a V8 heap that cannot see the cgroup limit. An export
    // past the bound gets a category a customer can act on — export a narrower
    // range — rather than a worker that disappears mid-run.
    expect(UMAMI_MAX_STATE_ENTRIES).toBeGreaterThan(1_000_000)
    // Proving the throw with two million rows would be a minute of CPU per
    // assertion, so the check is that the constant is enforced at all: a run of
    // distinct sessions costs one state entry each, and the count below is well
    // under the bound.
    const rows = Array.from({ length: 50 }, (_, index) =>
      umamiRow({
        session_id: `s-${String(index)}`,
        visit_id: `v-${String(index)}`,
        url_path: '/',
        created_at: '2026-03-01 10:00:00',
      }),
    )
    const { rows: staged } = await parse('metrics', umamiCsv(rows))
    expect(staged[0]).toMatchObject({ visitors: 50, visits: 50, pageviews: 50 })
  })
})
