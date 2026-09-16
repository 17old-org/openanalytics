import { deflateRawSync } from 'node:zlib'
import {
  ImportRunFailure,
  scrubImportDimension,
  type ImportAdapter,
  type ImportRowBatch,
  type ImportedReport,
  type ParseEntryInput,
} from '@openanalytics/domain'

/**
 * Fixtures for the M11 import pipeline (ADR-0032, CP2).
 *
 * Two things live here, and both exist because the pipeline's guarantees can
 * only be proven against **real bytes**:
 *
 * - `buildZip` writes a genuine ZIP container — local headers, a central
 *   directory and an end-of-central-directory record — so the walker is tested
 *   against the format rather than against a mock of it. A hostile archive is
 *   then just a fixture with unusual arguments: a high-ratio member, a nested
 *   `.zip` entry, thirty-three files, a row with no newline, a zip64 sentinel.
 * - `testFixtureAdapter` is the `test_fixture` provider. It is registered
 *   **only in tests** (ADR-0032 D11: CP2 ships no production adapter; Plausible
 *   is CP3), which is what lets the executor suite exercise the whole staging
 *   path without pretending to have a provider parser it does not have.
 */

// --- A real ZIP writer -------------------------------------------------------

export interface ZipMember {
  readonly name: string
  readonly content: string | Buffer
  /** Stored instead of deflated. Used to build a member whose bytes are exactly
   * predictable. */
  readonly stored?: boolean
  /**
   * Write the zip64 sentinel (`0xFFFFFFFF`) into this member's central-directory
   * sizes. A real zip64 archive carries the true values in an extra field; the
   * walker refuses the sentinel outright rather than reading one.
   */
  readonly zip64Sentinel?: boolean
  /**
   * Write a false uncompressed size into the central directory.
   *
   * The directory is what the walker's cheap pre-check reads, so understating a
   * member here is how a fixture proves the *stream* budget rather than the
   * pre-check: the archive claims to be small and inflates to something that is
   * not.
   */
  readonly declaredUncompressedSize?: number
  /** Replace the deflated payload with bytes that are not a deflate stream, so
   * the inflate fails mid-entry. */
  readonly corruptPayload?: boolean
  /**
   * General-purpose bit flags, written into both records. Bit 0 is the
   * encryption flag — an entry the reader must refuse rather than skip, because
   * skipping would import as though the encrypted report simply was not there.
   */
  readonly generalPurposeFlags?: number
  /**
   * Write a different name into the **local** header than into the central
   * directory.
   *
   * The reader trusts the directory for every decision and the local header for
   * where the bytes are, so a divergence is an archive that can present one
   * filename to the adapter and a different member to the parser.
   */
  readonly localNameOverride?: string
}

export interface ZipOptions {
  /**
   * Bytes appended after the end-of-central-directory record, with its comment
   * length set to match.
   *
   * The EOCD signature is four bytes and can occur inside a comment (or inside
   * compressed data), so the reader scans **backwards** and the record it finds
   * must be the last one. A fixture with a comment containing a decoy signature
   * is what proves the direction of that scan.
   */
  readonly comment?: Buffer
}

const SIGNATURE_LOCAL = 0x04034b50
const SIGNATURE_CENTRAL = 0x02014b50
const SIGNATURE_EOCD = 0x06054b50

/** CRC-32, table-free. The walker does not verify it, but a real ZIP carries
 * one and a fixture that wrote zeros would be a fixture that only proves the
 * walker ignores the field. */
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function buildZip(members: readonly ZipMember[], options: ZipOptions = {}): Buffer {
  const locals: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0

  for (const member of members) {
    const raw = Buffer.isBuffer(member.content)
      ? member.content
      : Buffer.from(member.content, 'utf8')
    const stored = member.stored === true
    const compressed = stored ? raw : deflateRawSync(raw)
    const data = member.corruptPayload === true ? Buffer.alloc(compressed.length, 0xff) : compressed
    const name = Buffer.from(member.name, 'utf8')
    const localName =
      member.localNameOverride === undefined ? name : Buffer.from(member.localNameOverride, 'utf8')
    const method = stored ? 0 : 8
    const sentinel = member.zip64Sentinel === true
    const flags = member.generalPurposeFlags ?? 0

    const local = Buffer.alloc(30 + localName.length)
    local.writeUInt32LE(SIGNATURE_LOCAL, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0, 12) // date
    local.writeUInt32LE(crc32(raw), 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(localName.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    localName.copy(local, 30)

    locals.push(local, data)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(SIGNATURE_CENTRAL, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc32(raw), 16)
    central.writeUInt32LE(sentinel ? 0xffffffff : data.length, 20)
    central.writeUInt32LE(
      sentinel ? 0xffffffff : (member.declaredUncompressedSize ?? raw.length),
      24,
    )
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    directory.push(central)

    offset += local.length + data.length
  }

  const directoryBuffer = Buffer.concat(directory)
  const comment = options.comment ?? Buffer.alloc(0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIGNATURE_EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(members.length, 8)
  eocd.writeUInt16LE(members.length, 10)
  eocd.writeUInt32LE(directoryBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(comment.length, 20)

  return Buffer.concat([...locals, directoryBuffer, eocd, comment])
}

// --- A realistic Plausible export --------------------------------------------

/**
 * The ten CSVs a Plausible export contains, in the provider's own column orders
 * (verified 2026-07-29 against plausible.io/docs/csv-import).
 *
 * Deliberately *not* minimal. The point of this fixture is that the adapter meets
 * the export it will actually meet, so it carries the things a hand-written
 * fixture leaves out and a real archive does not:
 *
 * - **quoted fields containing commas** — a page title-ish path and a UTM
 *   campaign, which a `split(',')` parser would shear apart;
 * - **a doubled quote** inside a quoted value, RFC 4180's escape;
 * - **a real GeoNames city id** in `imported_locations`, so the `city_dropped`
 *   warning has something to count;
 * - **`imported_entry_pages` and `imported_exit_pages`**, which the adapter must
 *   recognise and drop with a note rather than refuse as an unknown entry;
 * - **column orders that differ between files** (`visitors` is second in some and
 *   ninth in others), which is what makes header-by-name mapping load-bearing.
 */
export const PLAUSIBLE_EXPORT_RANGE = { from: '20240101', to: '20240103' } as const

export function plausibleEntryName(table: string): string {
  return `imported_${table}_${PLAUSIBLE_EXPORT_RANGE.from}_${PLAUSIBLE_EXPORT_RANGE.to}.csv`
}

/** Every table's rows, header included, exactly as Plausible writes them. */
export const PLAUSIBLE_CSVS: Readonly<Record<string, string>> = {
  visitors: [
    'date,visitors,pageviews,bounces,visits,visit_duration',
    '2024-01-01,10,25,4,12,600',
    '2024-01-02,14,31,5,16,720',
    '2024-01-03,9,18,3,10,430',
  ].join('\n'),

  sources: [
    'date,source,referrer,utm_source,utm_medium,utm_campaign,utm_content,utm_term,pageviews,visitors,visits,visit_duration,bounces',
    '2024-01-01,Google,google.com,,,,,,12,6,7,300,2',
    // A campaign name with a comma, quoted. Unquoted this row would parse as
    // fourteen cells and shift every count one place left.
    '2024-01-02,Newsletter,news.example.com,newsletter,email,"spring, 2024",cta-a,,9,5,6,280,1',
    '2024-01-03,,,,,,,,4,3,3,120,1',
  ].join('\n'),

  pages: [
    'date,hostname,page,visits,visitors,pageviews',
    '2024-01-01,shop.example.com,/,7,6,10',
    // A path containing a comma and an RFC 4180 doubled quote.
    '2024-01-02,shop.example.com,"/blog/hello,-world-""quoted""",4,4,6',
    '2024-01-03,docs.example.com,/pricing,3,3,5',
  ].join('\n'),

  entry_pages: [
    'date,entry_page,visitors,entrances,visit_duration,bounces,pageviews',
    '2024-01-01,/,6,7,300,2,10',
  ].join('\n'),

  exit_pages: [
    'date,exit_page,visitors,visit_duration,exits,bounces,pageviews',
    '2024-01-01,/pricing,4,180,5,1,6',
  ].join('\n'),

  custom_events: [
    'date,name,link_url,path,visitors,events',
    '2024-01-01,Signup,,,3,4',
    '2024-01-02,Outbound Link: Click,https://partner.example.com/a,,2,2',
  ].join('\n'),

  locations: [
    'date,country,region,city,visitors,visits,visit_duration,bounces,pageviews',
    // 2643743 is London. A GeoNames id, which nothing here can resolve to the
    // name the live geography dimension uses — so the column is dropped and the
    // reviewer is told how many rows carried one.
    '2024-01-01,GB,GB-ENG,2643743,5,6,240,2,8',
    '2024-01-02,DE,DE-BE,,4,4,190,1,6',
  ].join('\n'),

  browsers: [
    'date,browser,browser_version,visitors,visits,visit_duration,bounces,pageviews',
    '2024-01-01,Chrome,120.0,7,8,320,3,12',
    '2024-01-02,Safari,17.2,4,4,180,1,6',
  ].join('\n'),

  operating_systems: [
    'date,operating_system,operating_system_version,visitors,visits,visit_duration,bounces,pageviews',
    '2024-01-01,Windows,11,6,7,300,2,11',
    '2024-01-02,macOS,14.2,5,5,210,1,7',
  ].join('\n'),

  devices: [
    'date,device,visitors,visits,visit_duration,bounces,pageviews',
    '2024-01-01,Desktop,8,9,360,3,14',
    '2024-01-02,Mobile,6,7,250,2,9',
  ].join('\n'),
}

/**
 * Rewrites one entry as a Windows-authored CSV: a UTF-8 BOM on the header and
 * CRLF line endings throughout.
 *
 * Not exotic — it is what a spreadsheet round-trip produces, and both halves are
 * invisible failures if unhandled. The BOM becomes part of the first column's
 * *name*, so `date` stops being found and the entry fails as "missing a required
 * column"; the trailing `\r` becomes part of the last cell's value, so a count
 * stops parsing and a dimension gains a control character.
 */
export function toCrlfWithBom(csv: string): string {
  return `\ufeff${csv.split('\n').join('\r\n')}`
}

/** The whole export as a real ZIP. `omit` drops entries; `override` replaces one
 * file's text, which is how a malformed-header or bad-number case is built. */
export function buildPlausibleZip(
  options: {
    omit?: readonly string[]
    override?: Readonly<Record<string, string>>
    /** Entries to re-encode as BOM + CRLF. */
    crlfBom?: readonly string[]
  } = {},
): Buffer {
  const omit = new Set(options.omit ?? [])
  const crlf = new Set(options.crlfBom ?? [])
  const members: ZipMember[] = []
  for (const [table, csv] of Object.entries(PLAUSIBLE_CSVS)) {
    if (omit.has(table)) continue
    const content = options.override?.[table] ?? csv
    members.push({
      name: plausibleEntryName(table),
      content: crlf.has(table) ? toCrlfWithBom(content) : content,
    })
  }
  return buildZip(members)
}

// --- A realistic Umami Cloud export ------------------------------------------

/**
 * The `website_event.csv` column order of a real Umami Cloud export, verified
 * 2026-08-26 against one taken from the product.
 *
 * The adapter addresses every column **by name**, so this order is here for the
 * fixture rather than for the parser — which is precisely what a reordered-header
 * test then proves.
 */
export const UMAMI_COLUMNS = [
  'website_id',
  'session_id',
  'visit_id',
  'event_id',
  'hostname',
  'browser',
  'os',
  'device',
  'screen',
  'language',
  'country',
  'region',
  'city',
  'url_path',
  'url_query',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'referrer_path',
  'referrer_query',
  'referrer_domain',
  'page_title',
  'gclid',
  'fbclid',
  'msclkid',
  'ttclid',
  'li_fat_id',
  'twclid',
  'lcp',
  'inp',
  'cls',
  'fcp',
  'ttfb',
  'event_type',
  'event_name',
  'tag',
  'distinct_id',
  'created_at',
  'job_id',
] as const

export type UmamiColumn = (typeof UMAMI_COLUMNS)[number]

/** The columns a Cloud export renders as an **unquoted** `\N` when null, plus
 * `event_type`, which it renders as an unquoted integer. Everything else is
 * always double-quoted, the empty string included. */
const UMAMI_UNQUOTED: ReadonlySet<string> = new Set([
  'lcp',
  'inp',
  'cls',
  'fcp',
  'ttfb',
  'job_id',
  'event_type',
])

/** Invented, in the confirmed shape. A real export's identifiers are a
 * customer's data and none of them are in this repository. */
const UMAMI_WEBSITE = '00000000-0000-4000-8000-0000000000aa'

export type UmamiEvent = Partial<Record<UmamiColumn, string>>

/**
 * One row in the provider's dialect: every string field double-quoted, the
 * nullable numerics an unquoted `\N`, `event_type` an unquoted integer.
 *
 * Values are written verbatim — a fixture needing a doubled quote or a literal
 * newline writes one — because the point of these rows is to meet the reader the
 * way the provider does, not the way a helper would prefer.
 */
export function umamiRow(event: UmamiEvent): string {
  return UMAMI_COLUMNS.map((column) => {
    const value = event[column]
    if (UMAMI_UNQUOTED.has(column)) {
      if (value !== undefined) return value
      return column === 'event_type' ? '1' : '\\N'
    }
    return `"${value ?? ''}"`
  }).join(',')
}

/** Header plus rows, LF-terminated with a trailing newline — the dialect the
 * sample export uses (UTF-8, no BOM, LF only). */
export function umamiCsv(rows: readonly string[]): string {
  const header = UMAMI_COLUMNS.map((column) => `"${column}"`).join(',')
  return [header, ...rows, ''].join('\n')
}

const S1 = '10000000-0000-4000-8000-000000000001'
const S2 = '10000000-0000-4000-8000-000000000002'
const S3 = '10000000-0000-4000-8000-000000000003'
const V1 = '20000000-0000-4000-8000-000000000001'
const V2 = '20000000-0000-4000-8000-000000000002'
const V3 = '20000000-0000-4000-8000-000000000003'
const V4 = '20000000-0000-4000-8000-000000000004'

/** The one row the fixture repeats, verbatim, out of place, later in the file. */
const UMAMI_REPEATED_ROW = umamiRow({
  website_id: UMAMI_WEBSITE,
  session_id: S1,
  visit_id: V1,
  event_id: '30000000-0000-4000-8000-000000000002',
  hostname: 'shop.example.com',
  browser: 'chrome',
  os: 'Windows 10',
  device: 'desktop',
  screen: '1920x1080',
  language: 'en-GB',
  country: 'GB',
  region: 'GB-ENG',
  city: 'London',
  url_path: '/pricing',
  referrer_domain: 'www.example.net',
  page_title: 'Pricing',
  created_at: '2026-03-01 10:00:30',
})

/**
 * Two days of events, deliberately awkward in every way the adapter claims to
 * tolerate.
 *
 * Written so that every staged number is hand-checkable from the rows, and so
 * that each load-bearing decision has something to bite on:
 *
 * - **unsorted** — the second day is written first, so a parser that assumed a
 *   date-ordered file would close a day that is not finished;
 * - **a duplicate `event_id`**, out of place, which must be counted and dropped;
 * - **a `page_title` containing a newline**, which the pipeline hands over as two
 *   lines and the adapter must stitch back into one record;
 * - **a custom event alone in its visit** on the second day, which is excluded
 *   from visits, bounces and duration and whose dimensions must not fabricate an
 *   all-zero row on four breakdowns;
 * - **a performance row** (`event_type` 5), which changes no measure;
 * - **a quoted comma** in a UTM campaign, which a `split(',')` would shear;
 * - **`XX`**, the unresolved-country placeholder, which must not become a nation.
 *
 * The daily totals it implies, which are Umami's own definitions:
 *
 * | day        | pageviews | visitors | visits | bounces | duration |
 * | ---------- | --------- | -------- | ------ | ------- | -------- |
 * | 2026-03-01 | 3         | 2        | 2      | 1       | 30       |
 * | 2026-03-02 | 2         | 1        | 1      | 0       | 20       |
 */
export const UMAMI_EVENT_ROWS: readonly string[] = [
  // --- the second day, written first ---
  umamiRow({
    website_id: UMAMI_WEBSITE,
    session_id: S3,
    visit_id: V3,
    event_id: '30000000-0000-4000-8000-000000000005',
    hostname: 'docs.example.com',
    browser: 'crios',
    os: 'Mac OS',
    device: 'tablet',
    screen: '820x1180',
    language: 'de',
    // The placeholder some platforms send for an address they could not resolve.
    country: 'XX',
    url_path: '/',
    page_title: 'Docs',
    created_at: '2026-03-02 09:00:00',
  }),
  umamiRow({
    website_id: UMAMI_WEBSITE,
    session_id: S3,
    visit_id: V3,
    event_id: '30000000-0000-4000-8000-000000000006',
    hostname: 'docs.example.com',
    browser: 'crios',
    os: 'Mac OS',
    device: 'tablet',
    country: 'XX',
    url_path: '/',
    lcp: '1200',
    ttfb: '80',
    event_type: '5',
    created_at: '2026-03-02 09:00:10',
  }),
  umamiRow({
    website_id: UMAMI_WEBSITE,
    session_id: S3,
    visit_id: V3,
    event_id: '30000000-0000-4000-8000-000000000007',
    hostname: 'docs.example.com',
    browser: 'crios',
    os: 'Mac OS',
    device: 'tablet',
    country: 'XX',
    url_path: '/',
    page_title: 'Docs',
    created_at: '2026-03-02 09:00:20',
  }),
  umamiRow({
    website_id: UMAMI_WEBSITE,
    session_id: S1,
    visit_id: V4,
    event_id: '30000000-0000-4000-8000-000000000008',
    hostname: 'shop.example.com',
    browser: 'chrome',
    os: 'Windows 10',
    device: 'desktop',
    country: 'GB',
    region: 'GB-ENG',
    url_path: '/',
    event_type: '2',
    event_name: 'Signup',
    created_at: '2026-03-02 23:59:00',
  }),

  // --- the first day ---
  umamiRow({
    website_id: UMAMI_WEBSITE,
    session_id: S1,
    visit_id: V1,
    event_id: '30000000-0000-4000-8000-000000000001',
    hostname: 'shop.example.com',
    browser: 'chrome',
    os: 'Windows 10',
    device: 'desktop',
    screen: '1920x1080',
    language: 'en-GB',
    country: 'GB',
    region: 'GB-ENG',
    city: 'London',
    url_path: '/',
    referrer_domain: 'www.example.net',
    // A literal newline inside a quoted field. Umami never strips one: the
    // tracker sends `document.title` verbatim and the server truncates at 500
    // characters and nothing else.
    page_title: 'Home\nand away',
    created_at: '2026-03-01 10:00:00',
  }),
  UMAMI_REPEATED_ROW,
  umamiRow({
    website_id: UMAMI_WEBSITE,
    session_id: S1,
    visit_id: V1,
    event_id: '30000000-0000-4000-8000-000000000003',
    hostname: 'shop.example.com',
    browser: 'chrome',
    os: 'Windows 10',
    device: 'desktop',
    country: 'GB',
    region: 'GB-ENG',
    city: 'London',
    url_path: '/pricing',
    referrer_domain: 'www.example.net',
    event_type: '2',
    event_name: 'Signup',
    created_at: '2026-03-01 10:01:00',
  }),
  umamiRow({
    website_id: UMAMI_WEBSITE,
    session_id: S2,
    visit_id: V2,
    event_id: '30000000-0000-4000-8000-000000000004',
    hostname: 'shop.example.com',
    browser: 'ios',
    os: 'iOS',
    device: 'mobile',
    screen: '390x844',
    language: 'de-DE',
    country: 'DE',
    region: 'DE-BE',
    city: 'Berlin',
    url_path: '/',
    utm_source: 'newsletter',
    utm_medium: 'email',
    // A campaign name with a comma. Unquoted this row would parse as forty-two
    // cells and shift every later value one place left.
    utm_campaign: 'spring, 2026',
    page_title: 'Home',
    created_at: '2026-03-01 11:00:00',
  }),

  // The repeat, out of place — nothing promises an export is ordered.
  UMAMI_REPEATED_ROW,
]

export const UMAMI_EVENT_CSV = umamiCsv(UMAMI_EVENT_ROWS)

/** The two property-bag files a Cloud export ships beside the event table.
 * Header-only, which is what they are for a site that recorded no such data. */
export const UMAMI_SESSION_DATA_CSV = '"website_id","session_id","data_key","string_value"\n'
export const UMAMI_EVENT_DATA_CSV = '"website_id","event_id","data_key","string_value"\n'

/** The whole export as a real ZIP, in the container the product delivers: three
 * entries at the archive root. */
export function buildUmamiZip(
  options: {
    eventCsv?: string
    /** Drop `session_data.csv` and `event_data.csv`, which a customer who
     * repacked the export by hand plausibly would. */
    omitDropped?: boolean
    extra?: readonly ZipMember[]
  } = {},
): Buffer {
  const members: ZipMember[] = [
    { name: 'website_event.csv', content: options.eventCsv ?? UMAMI_EVENT_CSV },
  ]
  if (options.omitDropped !== true) {
    members.push(
      { name: 'session_data.csv', content: UMAMI_SESSION_DATA_CSV },
      { name: 'event_data.csv', content: UMAMI_EVENT_DATA_CSV },
    )
  }
  return buildZip([...members, ...(options.extra ?? [])])
}

// --- The `test_fixture` adapter ----------------------------------------------

export const TEST_FIXTURE_PROVIDER = 'test_fixture'

/** `fixture_{report}.csv`, and a `fixture_dropped.csv` the adapter recognises
 * and deliberately does not stage — the shape D2's entry/exit-pages decision
 * takes for a real provider. */
export function fixtureEntryName(report: ImportedReport): string {
  return `fixture_${report}.csv`
}

const HEADERS: Readonly<Record<ImportedReport, string>> = {
  metrics: 'date,visitors,visits,pageviews,bounces,visit_duration',
  pages: 'date,hostname,page,visitors,visits,pageviews',
  sources: 'date,source,visitors,visits,pageviews,bounces,visit_duration',
  geography: 'date,country,region,visitors,visits,pageviews,bounces,visit_duration',
  devices: 'date,device,visitors,visits,pageviews,bounces,visit_duration',
  browsers: 'date,browser,visitors,visits,pageviews,bounces,visit_duration',
  os: 'date,operating_system,visitors,visits,pageviews,bounces,visit_duration',
  custom_events: 'date,name,visitors,events',
}

export function fixtureCsv(report: ImportedReport, rows: readonly string[]): string {
  return [HEADERS[report], ...rows].join('\n')
}

function number(value: string | undefined): number {
  const parsed = Number(value ?? '0')
  if (!Number.isFinite(parsed)) {
    throw new ImportRunFailure('malformed_csv', 'not a number')
  }
  return parsed
}

/**
 * A minimal, deliberately dumb adapter.
 *
 * It is not a model of a real provider — CP3's Plausible adapter is — and it is
 * kept small on purpose: what the executor suite proves is the *pipeline*
 * (chunking, tokens, resume, budgets, failure classification), and an adapter
 * with interesting behaviour of its own would make those assertions ambiguous.
 */
export const testFixtureAdapter: ImportAdapter = {
  providerId: TEST_FIXTURE_PROVIDER,

  reports() {
    return ['metrics', 'pages', 'custom_events']
  },

  expectedEntryPattern(report) {
    return new RegExp(`^fixture_${report}\\.csv$`)
  },

  reportForEntry(entryName) {
    for (const report of this.reports()) {
      if (entryName === fixtureEntryName(report)) return report
    }
    return null
  },

  droppedEntryPattern() {
    return /^fixture_dropped\.csv$/
  },

  parseEntry<R extends ImportedReport>(
    input: ParseEntryInput<R>,
  ): AsyncIterable<ImportRowBatch<R>> {
    return parse(input)
  },
}

async function* parse<R extends ImportedReport>(
  input: ParseEntryInput<R>,
): AsyncIterable<ImportRowBatch<R>> {
  let header: string | null = null
  let batch: unknown[] = []

  for await (const line of input.lines) {
    if (header === null) {
      header = line
      if (header !== HEADERS[input.report]) {
        throw new ImportRunFailure('malformed_csv', 'unexpected header')
      }
      continue
    }
    if (line.trim().length === 0) continue

    const cells = line.split(',')
    const date = cells[0] ?? ''
    if (input.report === 'metrics') {
      batch.push({
        date,
        visitors: number(cells[1]),
        visits: number(cells[2]),
        pageviews: number(cells[3]),
        bounces: number(cells[4]),
        visitDuration: number(cells[5]),
      })
    } else if (input.report === 'pages') {
      batch.push({
        date,
        hostname: scrubImportDimension(cells[1] ?? ''),
        page: scrubImportDimension(cells[2] ?? ''),
        visitors: number(cells[3]),
        visits: number(cells[4]),
        pageviews: number(cells[5]),
      })
    } else if (input.report === 'custom_events') {
      batch.push({
        date,
        name: scrubImportDimension(cells[1] ?? ''),
        link_url: '',
        linkUrl: '',
        path: '',
        visitors: number(cells[2]),
        events: number(cells[3]),
      })
    } else {
      throw new ImportRunFailure('malformed_csv', 'report not supported by the fixture adapter')
    }

    // One batch per row, so the pipeline's own chunking is what the suite
    // observes rather than the adapter's grouping.
    yield { report: input.report, rows: batch as never }
    batch = []
  }

  if (header === null) throw new ImportRunFailure('malformed_csv', 'entry is empty')
}
