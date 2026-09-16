import {
  CITY_DROPPED_WARNING,
  DIMENSION_TRUNCATED_WARNING,
  IMPORT_DEVICE_TOKENS,
  ImportRunFailure,
  UNKNOWN_COLUMN_WARNING,
  importLiveCountry,
  importLiveToken,
  scrubImportDimensionDetailed,
  type ImportAdapter,
  type ImportRowBatch,
  type ImportWarning,
  type ImportedReport,
  type ImportedRow,
  type ParseEntryInput,
} from '../import-adapter.ts'
import { canonicalReferrerHost } from '../referrer.ts'

/**
 * The Umami import adapter (ADR-0032, D2/D11 and its Umami amendment; provider
 * facts verified 2026-08-26 against umami v3.3.1 source **and** against a real
 * Umami Cloud export).
 *
 * ## What the export is
 *
 * Umami Cloud's data export (Settings → Data → Export, one website per export)
 * is a ZIP of three CSVs at the archive root: **`website_event.csv`**, which is
 * the whole event table, plus `session_data.csv` and `event_data.csv`, which are
 * the per-session and per-event property bags. Only the first is read; the other
 * two are **declared dropped** — recognised, accepted, recorded as a summary
 * note — because nothing in the staged reports has a home for a property bag,
 * and failing an ordinary export `unexpected_entry` would tell a customer their
 * archive is the wrong provider's.
 *
 * Self-hosted OSS Umami has no equivalent raw export (issue #3208, closed as
 * not-planned) and its v3 aggregated export carries no dates at all, so it is
 * not usable here. A self-hosted operator can produce the same CSV from their
 * database; the docs page says so.
 *
 * ## Why this adapter is shaped unlike the Plausible one
 *
 * Plausible ships ten daily-aggregate CSVs and its adapter is a per-file column
 * mapper. Umami ships **one event-level file** and every staged report is
 * something this adapter *computes* from it. Three consequences run through
 * everything below:
 *
 * 1. **One entry, eight reports.** `reportsForEntry` claims the event file under
 *    all eight, and the pipeline then calls `parseEntry` once per report — eight
 *    passes over the same local temp file. That is deliberate: a single pass
 *    yielding batches for eight reports at once would hold all eight aggregation
 *    states in memory simultaneously, on a worker with a 768 MB container. Per
 *    pass the state is one report's.
 *
 * 2. **The metrics are Umami's own, not this system's sessionizer.** A day's
 *    numbers are computed exactly the way `getWebsiteStats.ts` computes them, so
 *    a fully imported day shows the numbers the customer's Umami dashboard
 *    showed. The alternative — re-deriving sessions with the live rules — would
 *    produce a *better-defined* number that matches neither dashboard, and the
 *    customer's only signal would be totals that do not agree with the tool they
 *    are migrating off. The rule, per UTC day:
 *
 *    - a **pageview row** is one whose `event_type` is not 2 (custom event) and
 *      not 5 (performance). 1 is a pageview and 3/4 are link/pixel, which their
 *      SQL counts as pageviews too;
 *    - rows are grouped by `(session_id, visit_id)` over that day's pageview
 *      rows, which is what makes every measure below implicitly skip a visit
 *      with no pageview that day (their `group by` sees no such group at all);
 *    - `pageviews` = pageview rows; `visitors` = distinct `session_id` among
 *      them; `visits` = distinct `visit_id` among them; `bounces` = groups with
 *      exactly one pageview **and** no custom event; `visitDuration` = Σ per
 *      group of (max − min `created_at`), in whole seconds.
 *
 *    A session or a visit that spans midnight is counted in **each** day it
 *    touches, which is what Umami's own daily charts do.
 *
 * 3. **Nothing is assumed about row order.** No source promises one, and a
 *    community importer dedupes on `event_id`, which implies duplicates happen.
 *    So a pass accumulates state for every day at once and emits at the end,
 *    rather than streaming a day out when the date changes. That is the cost of
 *    the honesty and it is why `UMAMI_MAX_STATE_ENTRIES` exists.
 *
 * ## Dimension values
 *
 * Translated into this system's vocabulary through the shared helpers in
 * `import-adapter.ts`, for the same reason Plausible's are: an imported `Mac OS`
 * sitting beside a live `macos` is two rows on a merged breakdown that a
 * customer reads as two operating systems. Umami ships detect-browser tokens
 * (`ios`, `crios`, `edge-chromium`) rather than display names, so the spelling
 * tables below are Umami's, not Plausible's.
 *
 * Two dimensions are deliberately not carried:
 *
 * - **City.** Umami ships a plain city *name* (`Antalya`), not the GeoNames id
 *   Plausible ships — but the staged geography table has no city column at all
 *   (D2), so it is dropped either way and the reviewer is told with a count.
 * - **Browser and OS versions.** Umami has no version column, so both stage as
 *   the empty string rather than as an invented value.
 *
 * ## Known provider caveat
 *
 * `created_at` is UTC with no zone suffix, and was verified as genuine UTC
 * against the sample export (events at 20:32 local, UTC+4, exported as 16:32).
 * A single community report says exports taken from Umami Cloud's **US** servers
 * can be shifted by the US-Eastern offset. There is no knob for that — a
 * per-export timezone guess would be a number nobody measured — and the docs
 * page tells a customer whose hour-of-day looks shifted to get in touch.
 *
 * ## Still unconfirmed
 *
 * The sample is four chronological rows, which is too small to prove either way:
 * whether Cloud exports are sorted, whether duplicate `event_id` rows occur at
 * scale, and whether `event_type` 3/4/5 rows appear in a website export (the
 * columns exist; the sample has none). Every one of those is *tolerated* rather
 * than assumed, which is why the design above costs what it costs.
 */

export const UMAMI_PROVIDER_ID = 'umami'

/** How many rows the adapter groups into one yielded batch. The pipeline
 * re-buckets into byte-bounded chunks, so this only bounds the parser's own
 * working set between yields. */
const BATCH_ROWS = 500

/**
 * The event table, under any name the container gives it.
 *
 * Loose on the suffix and anchored on the prefix: the walker has already reduced
 * an entry to its basename, and a customer who re-zipped an export may have a
 * `website_event (1).csv` or a `website_event_2026.csv`. The pipeline refuses
 * every entry no report claims, so a loose pattern widens what is *accepted*
 * rather than what is executed.
 */
const STAGED_ENTRY_PATTERN = /^website_event.*\.csv$/

/** The two property-bag files a Cloud export ships beside the event table.
 * Recognised, dropped, and named in the summary by their token — never by their
 * filename, which is provider text from inside an unproven archive. */
const DROPPED_ENTRY_PATTERN = /^(session_data|event_data).*\.csv$/

/**
 * The order the eight reports are staged in.
 *
 * Unlike Plausible's, this order is not about failing cheaply — every pass reads
 * the same file, so they all cost the same to reach. It is about **state**: the
 * two highest-cardinality reports go last, so a run that is going to trip
 * `UMAMI_MAX_STATE_ENTRIES` has already staged the cheap seven and the operator
 * log names the expensive one.
 */
const REPORT_ORDER: readonly ImportedReport[] = [
  'metrics',
  'devices',
  'browsers',
  'os',
  'geography',
  'custom_events',
  'sources',
  'pages',
]

/**
 * The pass that reports the entry-level warnings.
 *
 * Eight passes read one file, so a warning about the *file* — an unknown column,
 * a duplicate row — would otherwise be emitted eight times and the summary would
 * show a count eight times too large (the pipeline sums per code and detail).
 * One designated pass emits them; the per-report warnings (`dimension_truncated`,
 * `city_dropped`) are genuinely per-report and are emitted where they happen.
 */
const WARNING_REPORT: ImportedReport = REPORT_ORDER[0] as ImportedReport

/** Rows dropped because an earlier row in the same day carried the same
 * `event_id`. Counted rather than named: a row is provider text. */
export const DUPLICATE_EVENTS_WARNING = 'duplicate_events_dropped'

// --- Columns -----------------------------------------------------------------

/**
 * The four columns without which no report can be computed.
 *
 * Deliberately short. Everything else is optional with an empty default, because
 * an export of a site that never saw a UTM parameter or a custom event is a
 * legitimate export and not a broken one — and because the exact column set has
 * moved across Umami versions. A missing one of *these* four, though, would
 * stage zeros that look like measurements.
 */
const REQUIRED_COLUMNS = ['session_id', 'visit_id', 'created_at', 'event_type'] as const

/** `region` was `subdivision1` before Umami v2.18. Read under either name so a
 * customer on an older export does not silently lose the dimension. */
const REGION_COLUMNS = ['region', 'subdivision1'] as const

/**
 * Every column a Cloud export is known to carry, so that anything else can be
 * counted as an `unknown_columns` warning.
 *
 * Transcribed from a real export's header (41 columns, 2026-08-26) plus the
 * pre-2.18 `subdivision1` spelling. The list exists **only** to decide what is
 * unknown — every value read is addressed by name, so a column moving, or a new
 * one appearing, changes nothing but this count.
 */
const KNOWN_COLUMNS: ReadonlySet<string> = new Set([
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
  'subdivision1',
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
])

/** `EVENT_TYPE` in umami v3: 1 pageView, 2 customEvent, 3 link, 4 pixel,
 * 5 performance. Only the two that change how a row is counted are named. */
const EVENT_TYPE_CUSTOM = 2
const EVENT_TYPE_PERFORMANCE = 5

/** What a `COPY ... TO CSV` writes for NULL, and what a Cloud export writes in
 * its nullable numeric and UUID columns. Read as the empty string, exactly like
 * `""`. The ambiguity this creates — a dimension whose real value is the two
 * characters `\N` — is not reachable through any column this adapter reads as a
 * dimension in practice, and the alternative (tracking whether each cell was
 * quoted) would complicate the reader for a value nobody writes. */
const NULL_LITERAL = '\\N'

// --- The provider's spelling -------------------------------------------------

/**
 * Umami's device classes → this system's tokens.
 *
 * The shared closed vocabulary plus one spelling that is Umami's own: its
 * classifier calls a wide screen a **`laptop`**, and the live side has no such
 * class. Folding it into `desktop` is what keeps a laptop's imported traffic on
 * the same row as its live traffic; leaving it to the closed fallback would put
 * every one of those visits into `unknown`.
 *
 * Everything else Umami can emit — `console`, `smarttv`, `wearable`, `xr`,
 * `embedded` — has no live counterpart and falls through to `unknown`, which is
 * the closed vocabulary doing its job.
 */
const DEVICE_TOKENS: Readonly<Record<string, string>> = {
  ...IMPORT_DEVICE_TOKENS,
  laptop: 'desktop',
}

/**
 * detect-browser's browser ids → this system's tokens.
 *
 * Umami stores what `detect-browser` returns, which is an id (`crios`,
 * `edge-chromium`, `ios-webview`) rather than a display name — so this table
 * looks nothing like Plausible's even though both end at the same tokens. The
 * unmapped remainder is lowercased through, not folded into `unknown`: a browser
 * this table has not heard of is still a real browser.
 */
const BROWSER_TOKENS: Readonly<Record<string, string>> = {
  chrome: 'chrome',
  crios: 'chrome',
  'chromium-webview': 'chrome',
  edge: 'edge',
  'edge-chromium': 'edge',
  'edge-ios': 'edge',
  firefox: 'firefox',
  fxios: 'firefox',
  safari: 'safari',
  ios: 'safari',
  'ios-webview': 'safari',
  opera: 'opera',
  'opera-mini': 'opera',
  samsung: 'samsung',
}

/**
 * detect-browser's OS names → this system's tokens.
 *
 * Every desktop `Windows *` variant is one `windows`, because the live
 * classifier emits one. **`Windows Mobile` is deliberately not** — it is a
 * different device class, and folding it into the desktop token would put phone
 * traffic into a customer's Windows row. It falls through the open vocabulary as
 * `windows mobile`, which is distinct and honest.
 */
const OS_TOKENS: Readonly<Record<string, string>> = {
  'windows 3.11': 'windows',
  'windows 95': 'windows',
  'windows 98': 'windows',
  'windows 2000': 'windows',
  'windows xp': 'windows',
  'windows server 2003': 'windows',
  'windows vista': 'windows',
  'windows 7': 'windows',
  'windows 8': 'windows',
  'windows 8.1': 'windows',
  'windows 10': 'windows',
  'windows 11': 'windows',
  'windows me': 'windows',
  'windows ce': 'windows',
  windows: 'windows',
  'mac os': 'macos',
  'mac os x': 'macos',
  macos: 'macos',
  ios: 'ios',
  'android os': 'android',
  android: 'android',
  'chrome os': 'chromeos',
  chromeos: 'chromeos',
  linux: 'linux',
  'gnu/linux': 'linux',
  ubuntu: 'linux',
  openbsd: 'linux',
  freebsd: 'linux',
}

// --- Budgets -----------------------------------------------------------------

/**
 * How many keys the aggregation state of one pass may hold before the run is
 * failed rather than the worker killed.
 *
 * "Key" is counted uniformly: a day, a dimension bucket, a session in a bucket's
 * visitor set, a visit slice, and a dedup token each cost one. The dedup set
 * dominates — it holds **one entry per row** — so this number is, in practice, a
 * row ceiling.
 *
 * The arithmetic it comes from: the worker container is 768 MB, a V8 heap does
 * not see a cgroup limit (so an OOM here is a container kill, not a catchable
 * error), and a Set or Map slot holding a short string costs on the order of a
 * hundred bytes once V8's hash tables are counted. Two million keys is therefore
 * roughly 200 MB of state — a third of the container, leaving the inflate
 * buffers, the insert chunk and the runtime the rest.
 *
 * Two million rows is also, not coincidentally, about what the pipeline's own
 * ceilings admit: `IMPORT_MAX_ARCHIVE_BYTES` is 256 MiB and an Umami event row
 * is ~500 bytes uncompressed. An export past this is refused with
 * `entry_too_large` — an honest category the customer can act on by exporting a
 * narrower range — rather than with a worker that disappears mid-run.
 */
export const UMAMI_MAX_STATE_ENTRIES = 2_000_000

/**
 * The largest record the line-stitcher will assemble, in UTF-16 code units.
 *
 * The pipeline frames **lines** and caps each at `IMPORT_MAX_ROW_BYTES`
 * (65 536 shipped), but a value containing a newline spans several of them — so
 * a bound has to exist here too, or a malformed quote near the top of a large
 * entry would concatenate the whole file into one string before failing. The
 * number mirrors the shipped line cap. Code units rather than bytes because this
 * package is dependency-free and will not encode a growing string on every
 * continuation line; a code unit is never more than one UTF-8 byte and often
 * fewer, so the real ceiling is looser than 64 KiB and still a ceiling. A record
 * legitimately longer than one maximal line does not occur in an export whose
 * longest field is a 500-character page title.
 */
const MAX_RECORD_UNITS = 65_536

/** How many lines one record may be stitched from. Belt to `MAX_RECORD_UNITS`'
 * braces: a pathological entry of many short unterminated lines is bounded by
 * whichever it reaches first. */
const MAX_RECORD_LINES = 64

// --- CSV ---------------------------------------------------------------------

/** A record the reader could not finish, because a quoted field was still open
 * when the line ended. Not a failure on its own: the rest of the record is on
 * the next line. */
export const UMAMI_RECORD_INCOMPLETE = 'incomplete'
/** A record the reader will not guess at. Always a failure. */
export const UMAMI_RECORD_MALFORMED = 'malformed'

export type UmamiCsvRecord =
  readonly string[] | typeof UMAMI_RECORD_INCOMPLETE | typeof UMAMI_RECORD_MALFORMED

/**
 * One CSV record, RFC 4180.
 *
 * The same reader as Plausible's with **one difference that matters**: an
 * unterminated quoted field is reported as `incomplete` rather than as a
 * failure, so the caller can stitch the next line on and try again.
 *
 * Plausible does not need that and this provider does: Umami never strips
 * newlines from `page_title` (the tracker sends `document.title` verbatim and
 * the server truncates at 500 characters and nothing else), so a page whose
 * title contains a line break produces a record the pipeline hands over as two
 * lines. Refusing it would fail a perfectly ordinary export.
 *
 * Everything else is refused exactly as strictly, and for the same reason: a
 * quote that opens after leading whitespace (` "a,b",c`) is three cells read
 * strictly and four read leniently, and text directly after a closing quote is a
 * record the reader would have to guess at. A parser that skipped unreadable
 * rows would publish a dashboard quietly missing whatever it could not read.
 */
export function parseUmamiCsvRecord(record: string): UmamiCsvRecord {
  const cells: string[] = []
  let index = 0
  for (;;) {
    if (record[index] === '"') {
      index += 1
      let value = ''
      let closed = false
      while (index < record.length) {
        if (record[index] === '"') {
          // A doubled quote inside a quoted field is one literal quote.
          if (record[index + 1] === '"') {
            value += '"'
            index += 2
            continue
          }
          index += 1
          closed = true
          break
        }
        value += record[index]
        index += 1
      }
      if (!closed) return UMAMI_RECORD_INCOMPLETE
      cells.push(value)
      if (index === record.length) return cells
      if (record[index] !== ',') return UMAMI_RECORD_MALFORMED
      index += 1
      continue
    }
    const end = record.indexOf(',', index)
    const raw = end === -1 ? record.slice(index) : record.slice(index, end)
    if (raw.trimStart().startsWith('"')) return UMAMI_RECORD_MALFORMED
    cells.push(raw)
    if (end === -1) return cells
    index = end + 1
  }
}

/** Strips the UTF-8 BOM and a CRLF carriage return. The sample export is LF and
 * BOM-free, but a customer who opened the CSV in a spreadsheet before re-zipping
 * it produces both, and neither is part of any value. */
function normalizeLine(line: string, first: boolean): string {
  const withoutCr = line.endsWith('\r') ? line.slice(0, -1) : line
  return first && withoutCr.charCodeAt(0) === 0xfeff ? withoutCr.slice(1) : withoutCr
}

// --- Values ------------------------------------------------------------------

/** Operator-facing context on a failure: which report and which line. Never the
 * row's content — the detail is logged beside a customer-visible category, and a
 * hostile CSV must not be able to write text into either. */
type RowContext = { readonly report: ImportedReport; readonly line: number }

const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|\+00(?::?00)?)?$/

/**
 * `YYYY-MM-DD HH:MM:SS` UTC → its calendar day and its epoch milliseconds.
 *
 * Umami writes no zone suffix; the ISO `T` separator and a trailing `Z` are
 * accepted too, because a self-hosted operator dumping the same table from their
 * own database gets one or the other depending on the client. **A non-UTC offset
 * is refused rather than converted**: an export claiming `+02:00` is not a shape
 * this adapter has ever seen, and guessing at it would shift a whole day's rows.
 *
 * The day is re-derived from the parsed date rather than sliced off the string,
 * so `2024-02-31` is a failure instead of a row nothing can ever query.
 */
function parseTimestamp(value: string, where: RowContext): { day: string; ms: number } {
  const match = TIMESTAMP.exec(value.trim())
  if (!match) {
    throw new ImportRunFailure('malformed_csv', 'created_at is not a UTC timestamp', where)
  }
  const [, year, month, dayOfMonth, hour, minute, second] = match as unknown as string[]
  const ms = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(dayOfMonth),
    Number(hour),
    Number(minute),
    Number(second),
  )
  if (Number.isNaN(ms)) {
    throw new ImportRunFailure('malformed_csv', 'created_at is not a calendar instant', where)
  }
  const iso = new Date(ms).toISOString()
  // The round trip is the calendar check: `2024-02-31 00:00:00` parses happily
  // and comes back as March 2nd, which is a different day from the one the
  // provider wrote.
  if (iso.slice(0, 10) !== `${year}-${month}-${dayOfMonth}`) {
    throw new ImportRunFailure('malformed_csv', 'created_at is not a calendar instant', where)
  }
  return { day: iso.slice(0, 10), ms }
}

const DIGITS = /^-?\d+$/

/** `event_type`, as a small integer. Digits only, for the reason every other
 * count in this milestone is digits only: `Number()` would read `1e3` as a
 * thousand and an export producing that is not one this parser understands. */
function parseEventType(value: string, where: RowContext): number {
  const trimmed = value.trim()
  if (!DIGITS.test(trimmed)) {
    throw new ImportRunFailure('malformed_csv', 'event_type is not an integer', where)
  }
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed)) {
    throw new ImportRunFailure('malformed_csv', 'event_type is out of range', where)
  }
  return parsed
}

/**
 * A 64-bit token for one `event_id`, packed into four UTF-16 code units.
 *
 * Two independent 32-bit FNV-1a passes with a murmur3 finalizer, which is enough
 * for a dedup set: at the two-million-row ceiling the chance of any collision is
 * around one in ten million, and a collision costs one dropped row that the
 * duplicate warning has already told the reviewer about.
 *
 * The **shape** is the point rather than the algorithm. A dedup set holds one
 * entry per row, so at two million rows a set of 36-character UUID strings is
 * over a hundred megabytes on a 768 MB worker. Four code units is a flat string
 * V8 stores in a couple of dozen bytes. It is never serialised, never logged and
 * never compared to anything but another token, so lone surrogates in it are
 * fine.
 */
function eventToken(eventId: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let index = 0; index < eventId.length; index += 1) {
    const code = eventId.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193)
    b = Math.imul(b ^ code, 0x85ebca6b)
  }
  a ^= a >>> 16
  a = Math.imul(a, 0x85ebca6b)
  a ^= a >>> 13
  b ^= b >>> 16
  b = Math.imul(b, 0xc2b2ae35)
  b ^= b >>> 13
  return String.fromCharCode(a & 0xffff, (a >>> 16) & 0xffff, b & 0xffff, (b >>> 16) & 0xffff)
}

/** The separator between a bucket key's dimension values.
 *
 * NUL rather than a printable character because `scrubImportDimension` replaces
 * every control character with a space — so no scrubbed value can contain one,
 * and no two distinct dimension tuples can collide on the joined key. A comma
 * would: `("a,b", "c")` and `("a", "b,c")` are different tuples that would share
 * a key. */
const SEPARATOR = '\u0000'

/** Joins a bucket's dimension values into one map key. */
function bucketKey(dimensions: readonly string[]): string {
  return dimensions.join(SEPARATOR)
}

// --- Aggregation state -------------------------------------------------------

/** One `(session_id, visit_id)` group of a day, which is the unit Umami's own
 * stats query groups by. `views === 0` means the visit touched this day with
 * custom events only, and their `group by` over pageview rows would not have
 * produced it at all — so it is skipped at emit. */
interface VisitSlice {
  views: number
  customs: number
  minMs: number
  maxMs: number
}

/** A bucket carrying the full session measures: metrics, sources, geography,
 * devices, browsers, os. */
interface SessionBucket {
  readonly dimensions: readonly string[]
  views: number
  readonly sessions: Set<string>
  readonly visits: Map<string, VisitSlice>
}

/** The pages report, whose staged row has no bounces and no duration — so it
 * needs distinct visits but not their slices. */
interface ViewBucket {
  readonly dimensions: readonly string[]
  views: number
  readonly sessions: Set<string>
  readonly visits: Set<string>
}

/** The custom-events report: a count and a distinct-visitor set, per name. */
interface EventBucket {
  readonly dimensions: readonly string[]
  events: number
  readonly sessions: Set<string>
}

type Bucket = SessionBucket | ViewBucket | EventBucket

interface DayState {
  readonly buckets: Map<string, Bucket>
  /** Tokens of the `event_id`s already seen on this day. */
  readonly seen: Set<string>
}

/** Which bucket shape a report accumulates into. */
function bucketKindFor(report: ImportedReport): 'session' | 'view' | 'event' {
  if (report === 'pages') return 'view'
  if (report === 'custom_events') return 'event'
  return 'session'
}

// --- The adapter -------------------------------------------------------------

export const umamiImportAdapter: ImportAdapter = {
  providerId: UMAMI_PROVIDER_ID,

  reports() {
    return REPORT_ORDER
  },

  expectedEntryPattern() {
    // Every report is computed from the same entry, so there is one pattern
    // rather than one per report.
    return STAGED_ENTRY_PATTERN
  },

  reportForEntry(entryName) {
    // The first of the eight, so a caller that knows only the single-report
    // contract still recognises the entry. `reportsForEntry` is the authority.
    return STAGED_ENTRY_PATTERN.test(entryName) ? (REPORT_ORDER[0] as ImportedReport) : null
  },

  reportsForEntry(entryName) {
    return STAGED_ENTRY_PATTERN.test(entryName) ? REPORT_ORDER : []
  },

  droppedEntryPattern() {
    return DROPPED_ENTRY_PATTERN
  },

  droppedEntryToken(entryName) {
    // The capture, never the filename: the token reaches the customer's review
    // screen, and a filename is provider text from inside an archive nothing has
    // yet proven benign.
    return DROPPED_ENTRY_PATTERN.exec(entryName)?.[1] ?? null
  },

  parseEntry<R extends ImportedReport>(
    input: ParseEntryInput<R>,
  ): AsyncIterable<ImportRowBatch<R>> {
    return parseEntry(input)
  },
}

/**
 * Header row → column name to index.
 *
 * Duplicate names are refused rather than resolved by position: which of the two
 * a report reads would then depend on the order they happen to appear in, and
 * the reviewer would see a plausible number computed from the wrong column.
 */
function headerIndex(report: ImportedReport, cells: readonly string[]): Map<string, number> {
  const index = new Map<string, number>()
  for (const [position, raw] of cells.entries()) {
    const name = raw.trim().toLowerCase()
    if (name.length === 0) continue
    if (index.has(name)) {
      throw new ImportRunFailure('malformed_csv', 'header repeats a column name', { report })
    }
    index.set(name, position)
  }
  for (const required of REQUIRED_COLUMNS) {
    if (!index.has(required)) {
      throw new ImportRunFailure('malformed_csv', 'header is missing a required column', { report })
    }
  }
  return index
}

function unknownColumnCount(index: ReadonlyMap<string, number>): number {
  let unknown = 0
  for (const name of index.keys()) if (!KNOWN_COLUMNS.has(name)) unknown += 1
  return unknown
}

async function* parseEntry<R extends ImportedReport>(
  input: ParseEntryInput<R>,
): AsyncIterable<ImportRowBatch<R>> {
  const report = input.report
  const kind = bucketKindFor(report)

  const days = new Map<string, DayState>()
  let stateEntries = 0
  let duplicates = 0
  let citiesSeen = 0
  let unknownColumns = 0
  let truncated = 0

  let index: Map<string, number> | null = null
  let width = 0
  let lineNumber = 0
  let first = true
  let pendingRecord: string | null = null
  let pendingLines = 0

  /** Every new key in every map and set goes through here, so the bound is on
   * the state as a whole rather than on whichever structure grew fastest. */
  const claim = (): void => {
    stateEntries += 1
    if (stateEntries > UMAMI_MAX_STATE_ENTRIES) {
      throw new ImportRunFailure('entry_too_large', 'aggregation state exceeded', { report })
    }
  }

  const dayState = (day: string): DayState => {
    let state = days.get(day)
    if (!state) {
      claim()
      state = { buckets: new Map(), seen: new Set() }
      days.set(day, state)
    }
    return state
  }

  const bucketFor = (state: DayState, key: string, dimensions: readonly string[]): Bucket => {
    let bucket = state.buckets.get(key)
    if (!bucket) {
      claim()
      bucket =
        kind === 'session'
          ? { dimensions, views: 0, sessions: new Set(), visits: new Map() }
          : kind === 'view'
            ? { dimensions, views: 0, sessions: new Set(), visits: new Set() }
            : { dimensions, events: 0, sessions: new Set() }
      state.buckets.set(key, bucket)
    }
    return bucket
  }

  const addTo = (into: Set<string>, value: string): void => {
    if (into.has(value)) return
    claim()
    into.add(value)
  }

  const sliceFor = (bucket: SessionBucket, visitId: string): VisitSlice => {
    let slice = bucket.visits.get(visitId)
    if (!slice) {
      claim()
      slice = { views: 0, customs: 0, minMs: 0, maxMs: 0 }
      bucket.visits.set(visitId, slice)
    }
    return slice
  }

  for await (const raw of input.lines) {
    lineNumber += 1
    const line = normalizeLine(raw, first)
    first = false

    // **Before the header branch**, and only outside a stitched record: an entry
    // whose first line is blank would otherwise consume that line as its header
    // and fail with "missing a required column", which sends an operator looking
    // for a column problem in a file that has no content. Inside a quoted field
    // a blank line is a real blank line and belongs to the value.
    if (pendingRecord === null && line.trim().length === 0) continue

    const candidate: string = pendingRecord === null ? line : `${pendingRecord}\n${line}`
    const parsed = parseUmamiCsvRecord(candidate)

    if (parsed === UMAMI_RECORD_INCOMPLETE) {
      pendingLines += 1
      if (pendingLines > MAX_RECORD_LINES || candidate.length > MAX_RECORD_UNITS) {
        throw new ImportRunFailure('malformed_csv', 'record spans more than the record budget', {
          report,
          line: lineNumber,
        })
      }
      pendingRecord = candidate
      continue
    }
    if (parsed === UMAMI_RECORD_MALFORMED) {
      throw new ImportRunFailure('malformed_csv', 'row is not a readable CSV record', {
        report,
        line: lineNumber,
      })
    }
    pendingRecord = null
    pendingLines = 0
    const cells = parsed

    if (index === null) {
      index = headerIndex(report, cells)
      width = cells.length
      unknownColumns = unknownColumnCount(index)
      continue
    }

    const where: RowContext = { report, line: lineNumber }
    // **A row must be exactly as wide as the header.** A short row would read
    // absent cells as empty — zeros that look like measurements — and a long one
    // means the reader and the writer disagree about where a field ended, which
    // is the shape a mis-parsed quote takes.
    if (cells.length !== width) {
      throw new ImportRunFailure('malformed_csv', 'row width does not match the header', where)
    }

    const at = (name: string): string => {
      const position = index?.get(name)
      if (position === undefined) return ''
      const value = cells[position] ?? ''
      return value === NULL_LITERAL ? '' : value
    }
    const text = (value: string): string => {
      const scrubbed = scrubImportDimensionDetailed(value)
      if (scrubbed.truncated) truncated += 1
      return scrubbed.value
    }

    const { day, ms } = parseTimestamp(at('created_at'), where)
    const state = dayState(day)

    // **Dedup before anything else is decided**, and identically in every pass:
    // the count has to be the same eight times over, or the designated pass
    // would report a number the other seven disagree with. A row with no
    // `event_id` at all is never deduped — every such row would otherwise
    // collapse into one.
    const eventId = at('event_id').trim()
    if (eventId.length > 0) {
      const token = eventToken(eventId)
      if (state.seen.has(token)) {
        duplicates += 1
        continue
      }
      claim()
      state.seen.add(token)
    }

    const sessionId = at('session_id').trim()
    const visitId = at('visit_id').trim()
    if (sessionId.length === 0 || visitId.length === 0) {
      // Both are NOT NULL in every Umami schema, and a blank one cannot be given
      // an identity here: every blank would merge into a single visitor and the
      // export would silently understate exactly the number a migration is
      // checked against.
      throw new ImportRunFailure('malformed_csv', 'row has no session or visit identity', where)
    }

    const eventType = parseEventType(at('event_type'), where)
    const isCustom = eventType === EVENT_TYPE_CUSTOM
    const isView = !isCustom && eventType !== EVENT_TYPE_PERFORMANCE

    if (kind === 'event') {
      // Custom events only, keyed on the event name.
      if (!isCustom) continue
      const name = text(at('event_name'))
      const bucket = bucketFor(state, name, [name]) as EventBucket
      bucket.events += 1
      addTo(bucket.sessions, sessionId)
      continue
    }

    if (kind === 'view') {
      // Pages: pageview rows only, and no bounce or duration to compute.
      if (!isView) continue
      const dimensions = [text(at('hostname')), text(at('url_path'))]
      const bucket = bucketFor(state, bucketKey(dimensions), dimensions) as ViewBucket
      bucket.views += 1
      addTo(bucket.sessions, sessionId)
      addTo(bucket.visits, visitId)
      continue
    }

    // A performance row is neither a pageview nor a custom event: it changes no
    // measure Umami's own query computes, so it touches no state.
    if (!isView && !isCustom) continue

    const dimensions = dimensionsFor(report, at, text)
    if (report === 'geography' && at('city').trim().length > 0) citiesSeen += 1

    const bucket = bucketFor(state, bucketKey(dimensions), dimensions) as SessionBucket
    const slice = sliceFor(bucket, visitId)
    if (isCustom) {
      // Counted only so that a visit with a custom event is not a bounce.
      slice.customs += 1
      continue
    }
    bucket.views += 1
    addTo(bucket.sessions, sessionId)
    if (slice.views === 0) {
      slice.minMs = ms
      slice.maxMs = ms
    } else {
      if (ms < slice.minMs) slice.minMs = ms
      if (ms > slice.maxMs) slice.maxMs = ms
    }
    slice.views += 1
  }

  if (pendingRecord !== null) {
    throw new ImportRunFailure('malformed_csv', 'entry ends inside a quoted field', { report })
  }
  if (index === null) {
    throw new ImportRunFailure('malformed_csv', 'entry is empty', { report })
  }

  // Emitted in sorted order rather than in insertion order. The resume path
  // re-parses from the start and skips the chunks already recorded, which is
  // only correct if chunk N of report R holds the same rows on every attempt —
  // so the emission order must not depend on anything but the file's content.
  let batch: ImportedRow<R>[] = []
  for (const day of [...days.keys()].sort()) {
    const state = days.get(day) as DayState
    for (const key of [...state.buckets.keys()].sort()) {
      const bucket = state.buckets.get(key) as Bucket
      // **A bucket with no pageview stages nothing.** Unsorted input forces a
      // bucket into existence the moment a *custom event* names its dimensions,
      // and if no pageview ever joins it every measure it could report is zero:
      // Umami's own query, grouping over pageview rows, would not have produced
      // the group at all. Staging it would put a row on a breakdown that says a
      // dimension was seen and then reports nothing about it.
      if (!hasRows(bucket)) continue
      batch.push(rowFor(report, day, bucket) as ImportedRow<R>)
      if (batch.length >= BATCH_ROWS) {
        yield { report, rows: batch }
        batch = []
      }
    }
  }

  const warnings: ImportWarning[] = []
  if (citiesSeen > 0) {
    // Umami ships a city *name* rather than Plausible's GeoNames id, and it is
    // dropped all the same: the staged geography table has no city column (D2).
    // The count is what tells the reviewer whether the loss matters for them.
    warnings.push({ code: CITY_DROPPED_WARNING, count: citiesSeen, detail: { report } })
  }
  if (truncated > 0) {
    warnings.push({ code: DIMENSION_TRUNCATED_WARNING, count: truncated, detail: { report } })
  }
  // The two entry-level counts, from one pass only: eight passes read one file,
  // and emitting them everywhere would multiply the customer-visible count by
  // eight.
  if (report === WARNING_REPORT) {
    if (unknownColumns > 0) {
      warnings.push({ code: UNKNOWN_COLUMN_WARNING, count: unknownColumns })
    }
    if (duplicates > 0) {
      warnings.push({ code: DUPLICATE_EVENTS_WARNING, count: duplicates })
    }
  }

  // The final yield always happens, even with an empty row list, because it is
  // what carries the warnings — a report whose only news is "the city column was
  // dropped" must still deliver it.
  yield { report, rows: batch, warnings }
}

/**
 * The dimension tuple a row contributes to, per report.
 *
 * Explicit per report, because a generic mapping would let a typo become an
 * absent dimension that every row then shares — one enormous bucket that looks
 * like a measurement.
 */
function dimensionsFor(
  report: ImportedReport,
  at: (name: string) => string,
  text: (value: string) => string,
): readonly string[] {
  switch (report) {
    case 'metrics':
      return []
    case 'devices':
      return [importLiveToken(text(at('device')), DEVICE_TOKENS, 'closed')]
    case 'browsers':
      // No version column in Umami, so the version is the empty string rather
      // than an invented value.
      return [importLiveToken(text(at('browser')), BROWSER_TOKENS, 'open'), '']
    case 'os':
      return [importLiveToken(text(at('os')), OS_TOKENS, 'open'), '']
    case 'geography':
      // `city` is read only to count it for the warning; it is never carried.
      return [importLiveCountry(text(at('country'))), text(regionValue(at))]
    case 'sources': {
      // Through the same canonicaliser the live referrer path uses, so an
      // imported `www.google.com` merges with a live `google.com` instead of
      // sitting beside it as a second acquisition source. Umami has already
      // stripped `www.` and blanked self-referrals; the canonicaliser is
      // idempotent over both.
      const referrer = canonicalReferrerHost(text(at('referrer_domain')))
      const utmSource = text(at('utm_source'))
      // **`source` is derived, not read.** Umami has no resolved-channel column
      // of its own, and the live imported-sources operation reads `referrer` and
      // the UTM triple — never `source` — so nothing merges on this value and
      // only the export surfaces it. Deriving it from two fields already in the
      // key means it adds no cardinality: utm_source when the visit carried one,
      // otherwise the referring host, otherwise empty for direct traffic.
      const source = utmSource !== '' ? utmSource : referrer
      return [
        source,
        referrer,
        utmSource,
        text(at('utm_medium')),
        text(at('utm_campaign')),
        text(at('utm_content')),
        text(at('utm_term')),
      ]
    }
    default:
      throw new ImportRunFailure('malformed_csv', 'report has no Umami dimension tuple', { report })
  }
}

/** `region`, or the pre-2.18 `subdivision1`. A helper rather than an inline
 * fallback so `dimensionsFor` stays a table of tuples. */
function regionValue(at: (name: string) => string): string {
  const region = at(REGION_COLUMNS[0])
  return region !== '' ? region : at(REGION_COLUMNS[1])
}

/** Whether a bucket has anything to report. See the emit loop for why a bucket
 * can exist with nothing in it. */
function hasRows(bucket: Bucket): boolean {
  return 'events' in bucket ? bucket.events > 0 : bucket.views > 0
}

/** Umami's own daily measures for one bucket (see the header's rule 2). */
function sessionMeasures(bucket: SessionBucket): {
  visitors: number
  visits: number
  pageviews: number
  bounces: number
  visitDuration: number
} {
  let visits = 0
  let bounces = 0
  let visitDuration = 0
  for (const slice of bucket.visits.values()) {
    // Their `group by` runs over pageview rows, so a visit that touched this day
    // with custom events only produces no group at all.
    if (slice.views === 0) continue
    visits += 1
    if (slice.views === 1 && slice.customs === 0) bounces += 1
    visitDuration += Math.floor((slice.maxMs - slice.minMs) / 1000)
  }
  return { visitors: bucket.sessions.size, visits, pageviews: bucket.views, bounces, visitDuration }
}

/** Bucket → the normalized row its report stages. */
function rowFor(report: ImportedReport, date: string, bucket: Bucket): ImportedRow {
  switch (report) {
    case 'metrics':
      return { date, ...sessionMeasures(bucket as SessionBucket) }
    case 'pages': {
      const view = bucket as ViewBucket
      return {
        date,
        hostname: view.dimensions[0] ?? '',
        page: view.dimensions[1] ?? '',
        visitors: view.sessions.size,
        visits: view.visits.size,
        pageviews: view.views,
      }
    }
    case 'sources': {
      const session = bucket as SessionBucket
      return {
        date,
        source: session.dimensions[0] ?? '',
        referrer: session.dimensions[1] ?? '',
        utmSource: session.dimensions[2] ?? '',
        utmMedium: session.dimensions[3] ?? '',
        utmCampaign: session.dimensions[4] ?? '',
        utmContent: session.dimensions[5] ?? '',
        utmTerm: session.dimensions[6] ?? '',
        ...sessionMeasures(session),
      }
    }
    case 'geography': {
      const session = bucket as SessionBucket
      return {
        date,
        country: session.dimensions[0] ?? '',
        region: session.dimensions[1] ?? '',
        ...sessionMeasures(session),
      }
    }
    case 'devices': {
      const session = bucket as SessionBucket
      return { date, device: session.dimensions[0] ?? '', ...sessionMeasures(session) }
    }
    case 'browsers': {
      const session = bucket as SessionBucket
      return {
        date,
        browser: session.dimensions[0] ?? '',
        browserVersion: session.dimensions[1] ?? '',
        ...sessionMeasures(session),
      }
    }
    case 'os': {
      const session = bucket as SessionBucket
      return {
        date,
        operatingSystem: session.dimensions[0] ?? '',
        osVersion: session.dimensions[1] ?? '',
        ...sessionMeasures(session),
      }
    }
    case 'custom_events': {
      const event = bucket as EventBucket
      return {
        date,
        name: event.dimensions[0] ?? '',
        // Plausible's two goal-specific properties. Umami's custom events carry
        // neither, and an invented value would be worse than an empty one.
        linkUrl: '',
        path: '',
        visitors: event.sessions.size,
        events: event.events,
      }
    }
    default: {
      // Exhaustiveness, checked by the compiler: a ninth report added to
      // `IMPORTED_REPORTS` fails to build here rather than falling through to
      // whichever branch happened to be last.
      const unreachable: never = report
      throw new ImportRunFailure(
        'malformed_csv',
        `no Umami mapping for report "${String(unreachable)}"`,
      )
    }
  }
}
