/**
 * The import adapter framework (ADR-0032, D2/D6.3/D11).
 *
 * One descriptor and one parser interface per provider, so that adding Umami or
 * Matomo is a module plus a catalog row rather than a second pipeline. The split
 * is deliberate and it is the whole reason this file is dependency-free:
 *
 * - **The pipeline owns the bytes.** Downloading the archive, walking the ZIP,
 *   enforcing every budget during inflation, chunking rows, inserting them under
 *   a deterministic dedup token and recording progress on the run are all the
 *   worker's job. None of it varies per provider, and all of it is the part that
 *   has to be right under a hostile upload.
 * - **The adapter owns the semantics.** Which entry names belong to which
 *   report, what the CSV columns mean, which values are dropped and why. That is
 *   all a provider ever differs in, and it is pure text-in / rows-out.
 *
 * So an adapter receives already-inflated CSV **text, line by line**, and yields
 * normalized rows. It never sees a stream, a file, a budget or a database, which
 * means a provider matrix (F-302) can be written and tested without any of them
 * — and a badly written future adapter cannot weaken the parsing defences,
 * because it is not the thing doing the parsing.
 *
 * The rows below carry no `site_id` and no `import_run_id`: those are the
 * pipeline's, stamped at insert time. An adapter that could name a site id would
 * be an adapter that could stage rows into somebody else's site.
 */

/**
 * The eight staged reports (D2), each of which is exactly one ClickHouse table.
 *
 * They are named after what they *are* rather than after the provider file that
 * happens to fill them: Plausible's `imported_visitors` becomes `metrics`, and a
 * later provider's differently-named daily totals become the same report without
 * renaming a table.
 *
 * Two Plausible reports have no entry here and that is a decision, not a gap
 * (D2): `imported_entry_pages` and `imported_exit_pages` are dropped at staging
 * with a summary note, because no live entry/exit-pages operation exists to read
 * them and a staging table nothing serves would only widen the deletion registry
 * for free.
 */
export const IMPORTED_REPORTS = [
  'metrics',
  'pages',
  'sources',
  'geography',
  'devices',
  'browsers',
  'os',
  'custom_events',
] as const
export type ImportedReport = (typeof IMPORTED_REPORTS)[number]

/**
 * Report → ClickHouse table (migration 0015).
 *
 * Named here, in the pure package, because three places have to agree: the
 * insert path, the per-run cleanup, and the deletion registry's ClickHouse
 * target list. `DELETION_CLICKHOUSE_TARGETS` deliberately restates the names as
 * literals — that list is a fixed vocabulary a deletion snapshots, not a derived
 * one — and a unit test asserts the two agree, which is the check a derivation
 * would have silently removed.
 */
export const IMPORTED_REPORT_TABLES: Readonly<Record<ImportedReport, string>> = {
  metrics: 'imported_metrics_1d',
  pages: 'imported_pages_1d',
  sources: 'imported_sources_1d',
  geography: 'imported_geography_1d',
  devices: 'imported_devices_1d',
  browsers: 'imported_browsers_1d',
  os: 'imported_os_1d',
  custom_events: 'imported_custom_events_1d',
}

export function isImportedReport(value: unknown): value is ImportedReport {
  return typeof value === 'string' && (IMPORTED_REPORTS as readonly string[]).includes(value)
}

// --- Normalized row shapes ---------------------------------------------------

/** Every staged row is a calendar day. Aggregate-only providers have no finer
 * grain, and a fabricated hour would be a number nobody measured. */
interface ImportedDayRow {
  /** `YYYY-MM-DD`, UTC. The provider's own day boundary. */
  readonly date: string
}

/** Session measures a provider ships alongside its counts. `visitDuration` is
 * **total seconds**, never a stored average — averages are divided at read time
 * so two days can be merged by summing. */
interface ImportedSessionMeasures {
  readonly visitors: number
  readonly visits: number
  readonly pageviews: number
  readonly bounces: number
  readonly visitDuration: number
}

export interface ImportedMetricsRow extends ImportedDayRow, ImportedSessionMeasures {}

export interface ImportedPagesRow extends ImportedDayRow {
  readonly hostname: string
  readonly page: string
  readonly visitors: number
  readonly visits: number
  readonly pageviews: number
}

export interface ImportedSourcesRow extends ImportedDayRow, ImportedSessionMeasures {
  readonly source: string
  readonly referrer: string
  readonly utmSource: string
  readonly utmMedium: string
  readonly utmCampaign: string
  readonly utmContent: string
  readonly utmTerm: string
}

export interface ImportedGeographyRow extends ImportedDayRow, ImportedSessionMeasures {
  readonly country: string
  readonly region: string
}

export interface ImportedDevicesRow extends ImportedDayRow, ImportedSessionMeasures {
  readonly device: string
}

export interface ImportedBrowsersRow extends ImportedDayRow, ImportedSessionMeasures {
  readonly browser: string
  readonly browserVersion: string
}

export interface ImportedOsRow extends ImportedDayRow, ImportedSessionMeasures {
  readonly operatingSystem: string
  readonly osVersion: string
}

export interface ImportedCustomEventsRow extends ImportedDayRow {
  readonly name: string
  readonly linkUrl: string
  readonly path: string
  readonly visitors: number
  readonly events: number
}

/** The row shape a given report stages. */
export interface ImportedRowByReport {
  readonly metrics: ImportedMetricsRow
  readonly pages: ImportedPagesRow
  readonly sources: ImportedSourcesRow
  readonly geography: ImportedGeographyRow
  readonly devices: ImportedDevicesRow
  readonly browsers: ImportedBrowsersRow
  readonly os: ImportedOsRow
  readonly custom_events: ImportedCustomEventsRow
}
export type ImportedRow<R extends ImportedReport = ImportedReport> = ImportedRowByReport[R]

// --- Failure vocabulary ------------------------------------------------------

/**
 * The safe categories a failed run reports (D6 step 3).
 *
 * Every one of them is rendered to the customer, so none of them may carry a
 * provider message, a filename from the archive or a stack fragment: a hostile
 * CSV must not be able to write text onto somebody's dashboard, and a category
 * is the only shape that cannot. The detail an operator needs lives in the log
 * line beside the failure, which is not customer-visible.
 *
 * They are grouped by who has to act:
 *
 * - the **archive** categories (`zip_bomb` … `nested_archive`) mean the upload
 *   is not something this system will read, and the customer's action is to
 *   export again rather than to retry;
 * - `unexpected_entry` and `malformed_csv` mean the archive is a ZIP of the
 *   wrong thing — most often another provider's export;
 * - `adapter_unavailable` is *ours*: the run names a provider this build has no
 *   parser for, which is possible only if the catalog and the registry disagree
 *   or a deploy removed an adapter under a live run;
 * - `upload_changed` / `upload_unverifiable` are the ETag pin (D6 step 2)
 *   refusing bytes that are not the bytes `complete` checked;
 * - `upload_expired` is the sweeper's, and is listed here so the vocabulary is
 *   in one place rather than split between the worker and the sweeper.
 */
export const IMPORT_FAILURE_CATEGORIES = [
  'zip_bomb',
  'too_many_entries',
  'entry_too_large',
  'row_too_long',
  'unexpected_entry',
  'nested_archive',
  'malformed_archive',
  'malformed_csv',
  'empty_archive',
  'adapter_unavailable',
  'upload_changed',
  'upload_unverifiable',
  'upload_expired',
  /** The prepare job exhausted `JOB_MAX_ATTEMPTS` and will not run again. Its
   * own category rather than a reused one, because the customer's next step
   * differs: re-uploading the same archive is reasonable here and pointless for
   * every other category. */
  'prepare_abandoned',
] as const
export type ImportFailureCategory = (typeof IMPORT_FAILURE_CATEGORIES)[number]

export function isImportFailureCategory(value: unknown): value is ImportFailureCategory {
  return (
    typeof value === 'string' && (IMPORT_FAILURE_CATEGORIES as readonly string[]).includes(value)
  )
}

/**
 * A failure that ends the run rather than the job.
 *
 * The distinction the executor draws from it is the one that matters
 * operationally: a run that failed because the archive is wrong is **terminal
 * for the run and successful for the job** — nothing about retrying it later
 * would change the answer, and a job left retrying would poll a customer's
 * mistake until `JOB_MAX_ATTEMPTS`. Infrastructure failures are the opposite and
 * are deliberately *not* modelled here: they stay as their own error types
 * (`ObjectStorageError`, `ClickHouseInsertError`) so nothing can accidentally
 * convert an outage into a customer-visible "your file is broken".
 */
export class ImportRunFailure extends Error {
  readonly category: ImportFailureCategory
  /** Operator-facing context. Logged, never returned to the customer. */
  readonly detail: Record<string, unknown>

  constructor(
    category: ImportFailureCategory,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ImportRunFailure'
    this.category = category
    this.detail = detail
  }
}

// --- Warnings ----------------------------------------------------------------

/**
 * Something the reviewer must see before publishing (D2, D4).
 *
 * A warning is never a failure: the import is usable and *less complete than the
 * customer might assume*, which is precisely the class of fact that has to be
 * shown at the review step rather than logged. The three that exist today are
 * the dropped city dimension, the dropped entry/exit reports and the rows that
 * fall at or after the proposed cutover.
 */
export interface ImportWarning {
  readonly code: string
  /** Zero when the warning is structural ("this report was skipped") rather than
   * a count of affected rows. */
  readonly count: number
  /** Safe, bounded context — a report name or a dimension name, never provider
   * text. */
  readonly detail?: Readonly<Record<string, string | number>>
}

// --- The adapter -------------------------------------------------------------

/** One batch of parsed rows, as the adapter chooses to group them. The pipeline
 * re-buckets them into byte-bounded chunks, so a batch here is a convenience for
 * the parser and never the unit of insertion. */
export interface ImportRowBatch<R extends ImportedReport = ImportedReport> {
  readonly report: R
  readonly rows: readonly ImportedRow<R>[]
  /** Accumulated as parsing goes; the pipeline sums them per code. */
  readonly warnings?: readonly ImportWarning[]
}

export interface ParseEntryInput<R extends ImportedReport = ImportedReport> {
  readonly report: R
  /** The archive entry this text came from. Adapters use it only to decide the
   * dialect of a report that a provider ships in more than one shape. */
  readonly entryName: string
  /**
   * The entry's text, one line at a time, header included.
   *
   * An async iterable rather than a string or a buffer: the entry is being
   * inflated as this is consumed, and materialising it would defeat the whole
   * budgeted-streaming design. The pipeline has already enforced
   * `IMPORT_MAX_ROW_BYTES` per line, so an adapter never has to defend against
   * an unbounded one.
   */
  readonly lines: AsyncIterable<string>
}

/**
 * What one provider's export means.
 *
 * Deliberately small. Everything an adapter is asked for is a pure function of
 * text, which is what keeps the provider matrix cheap to extend and impossible
 * to get dangerously wrong.
 */
export interface ImportAdapter {
  /** Matches a `IMPORT_PROVIDERS` descriptor id. The registry is keyed on it, so
   * a run whose provider names no adapter fails `adapter_unavailable` rather
   * than being staged by the wrong parser. */
  readonly providerId: string

  /** The reports this adapter can emit, in the order the pipeline should stage
   * them. Order is the adapter's because it knows which report is cheapest to
   * fail on. */
  reports(): readonly ImportedReport[]

  /**
   * The entry names this report may arrive under.
   *
   * A pattern rather than a fixed name because providers put the exported range
   * in the filename (`imported_visitors_20240101_20241231.csv`). Anchored
   * patterns are the adapter's responsibility — the pipeline uses this only to
   * *recognise* an entry, and refuses any entry no report claims
   * (`unexpected_entry`), so a loose pattern widens what is accepted rather than
   * what is executed.
   */
  expectedEntryPattern(report: ImportedReport): RegExp

  /**
   * Which report an entry belongs to, or null for one this adapter does not
   * read.
   *
   * Null is not automatically a failure: a provider ships reports we
   * deliberately drop (entry/exit pages), and the pipeline distinguishes
   * "recognised and dropped" from "not recognised at all" through
   * `droppedEntryPattern`.
   */
  reportForEntry(entryName: string): ImportedReport | null

  /**
   * Every report an entry fills, for a provider that ships **one file behind
   * several reports**.
   *
   * Optional, and absent for the common case: a provider that exports one
   * daily-aggregate CSV per report answers `reportForEntry` and nothing else,
   * and the pipeline's single-report path is unchanged for it. An event-level
   * provider (Umami) ships one event table that every report is *aggregated
   * from*, and the honest description of that entry is a list rather than a
   * choice.
   *
   * What the pipeline does with the list is the minimal thing: the entry is
   * planned under each report, and `parseEntry` is then called once per report
   * exactly as before — so the entry is inflated and read **once per report**,
   * each pass building only that report's aggregation state. The alternative,
   * one pass yielding batches for eight reports at once, would hold all eight
   * states in memory simultaneously and would make `parseEntry`'s single-report
   * type a lie.
   *
   * An adapter that implements this **must** keep `reportForEntry` consistent
   * with it — the first element, or null — because the two answer the same
   * question and a caller is entitled to either.
   */
  reportsForEntry?(entryName: string): readonly ImportedReport[]

  /** Entries this adapter knows about and deliberately does not stage (D2). They
   * pass validation and are recorded as a summary note. */
  droppedEntryPattern(): RegExp | null

  /**
   * A safe, bounded token naming a dropped entry, for the summary warning.
   *
   * **Never the filename.** The warning is rendered to the customer, and a
   * filename is provider text from inside a hostile-until-proven archive — the
   * one thing the whole category vocabulary exists to keep off a dashboard. An
   * adapter that does not implement this gets a generic token, which is a worse
   * message and still not an injection.
   */
  droppedEntryToken?(entryName: string): string | null

  /** Parse one entry into row batches. Throws `ImportRunFailure('malformed_csv')`
   * for a header or a row it cannot read. */
  parseEntry<R extends ImportedReport>(input: ParseEntryInput<R>): AsyncIterable<ImportRowBatch<R>>
}

/**
 * The provider → adapter map the worker composes at startup.
 *
 * A `Map` rather than a module-level singleton, so a test can compose a registry
 * containing exactly the adapter it means to exercise and the production
 * registry stays the one place a real adapter is switched on. Two adapters ship
 * today — Plausible and Umami — and a run naming any other catalog provider
 * fails `adapter_unavailable`, which is the honest answer for a build with no
 * parser rather than a half-import.
 */
export type ImportAdapterRegistry = ReadonlyMap<string, ImportAdapter>

export function createImportAdapterRegistry(
  adapters: readonly ImportAdapter[],
): ImportAdapterRegistry {
  const registry = new Map<string, ImportAdapter>()
  for (const adapter of adapters) {
    if (registry.has(adapter.providerId)) {
      // A duplicate would make which parser runs depend on array order, which is
      // exactly the kind of thing that is discovered by a customer.
      throw new Error(`duplicate import adapter for provider "${adapter.providerId}"`)
    }
    registry.set(adapter.providerId, adapter)
  }
  return registry
}

// --- The live vocabulary -----------------------------------------------------

/*
 * Shared by every adapter, and here rather than in one of them because the rule
 * is not the provider's — it is *this system's*.
 *
 * The dimension values a provider ships are translated into the tokens the live
 * classifier emits, never stored as the provider spells them. Plausible writes
 * `Desktop`/`macOS`, Umami writes `desktop`/`Mac OS`, and the live path writes
 * `desktop`/`macos` (`anonymous-identity.ts`). Staging either provider's
 * spelling would put two rows on every merged breakdown — one for each side of
 * the cutover — that a customer would read as two different devices.
 *
 * What stays per-adapter is the **spelling table**: which provider strings map
 * onto which token. That is a fact about the provider. What is shared is the
 * fallback rule, the unknown token, the country rule and the closed device
 * vocabulary, because a second adapter differing on any of those would be a
 * second answer to a question the live side has only one answer to.
 */

/**
 * The token the live classifier uses when it could not tell.
 *
 * `normalizeUserAgentClass` returns `unknown` for an unresolvable device, browser
 * or OS, so an imported row with a blank one has to say `unknown` too — an empty
 * string would be a third value that merges with neither.
 *
 * Geography is deliberately different: the live path stores `''` for a country or
 * city it could not resolve (`normalizeCountry` returns null, which reaches
 * `events_raw` as the empty string), so an imported blank country stays blank.
 */
export const IMPORT_UNKNOWN_TOKEN = 'unknown'

/** `UserAgentClass['deviceType']` — the only four values the live side emits, so
 * the only four an imported devices row may carry. Providers spell them the same
 * way up to case, which is why this table is shared and the browser/OS ones are
 * not. */
export const IMPORT_DEVICE_TOKENS: Readonly<Record<string, string>> = {
  desktop: 'desktop',
  mobile: 'mobile',
  tablet: 'tablet',
}

/**
 * Provider spelling → this system's token.
 *
 * The fallback differs by dimension because the live vocabularies do:
 *
 * - **`closed`** is `device_type`, whose live values are exactly
 *   `desktop|mobile|tablet|unknown` (`UserAgentClass`). A fifth value cannot come
 *   out of the live classifier, so a provider's `Smart TV` has no live row to
 *   merge with and belongs in `unknown` rather than as a category only imported
 *   ranges can ever show.
 * - **`open`** is browser and OS, whose live rules name a handful of families and
 *   answer `unknown` for the rest. A browser this table has not heard of is still
 *   a real browser: lowercasing keeps it distinct, while folding it into
 *   `unknown` would merge it with the genuinely unresolvable rows.
 *
 * An empty value is `unknown` either way, which is what the live classifier
 * returns for a user agent it could not read.
 */
export function importLiveToken(
  value: string,
  table: Readonly<Record<string, string>>,
  vocabulary: 'closed' | 'open',
): string {
  const lowered = value.trim().toLowerCase()
  if (lowered === '') return IMPORT_UNKNOWN_TOKEN
  return table[lowered] ?? (vocabulary === 'closed' ? IMPORT_UNKNOWN_TOKEN : lowered)
}

/** ISO-3166-1 alpha-2, uppercased — `normalizeCountry`'s rule, minus the null:
 * the live rollup stores the empty string for a country it could not resolve, so
 * that is what an unusable provider value becomes here. `XX` and `T1` are the
 * placeholders some platforms send for unknown or Tor-exit addresses, and storing
 * one would put a fake nation in a customer's dashboard. */
export function importLiveCountry(value: string): string {
  const upper = value.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(upper) || upper === 'XX' || upper === 'T1') return ''
  return upper
}

// --- Value scrubbing ---------------------------------------------------------

/**
 * Longest dimension value staged, in **UTF-8 bytes**.
 *
 * Bytes rather than characters because the reason for the cap is storage and
 * transport — what a hostile export could make of every later ClickHouse row and
 * every export file — and those are measured in bytes. A 512-character cap would
 * admit 2 KiB of four-byte code points, which is four times the ceiling this
 * number is supposed to express.
 *
 * Above the live contract's 256-byte property ceiling because a URL-shaped page
 * value legitimately runs longer, and far below anything that could make a
 * dashboard cell a payload.
 */
export const IMPORT_DIMENSION_MAX_BYTES = 512

/** Appended to a value the cap cut, so a truncated dimension is visibly
 * truncated rather than silently a different (shorter) dimension that a merge
 * would then treat as its own key. One character, three bytes, inside the cap. */
export const IMPORT_TRUNCATION_SENTINEL = '…'

/** The reserved warning code for values the cap cut (D6.3). */
export const DIMENSION_TRUNCATED_WARNING = 'dimension_truncated'

/** The reserved code D2 names: the geography city column was present and carried
 * values this system has no column for. Shared rather than per-adapter because
 * every provider that ships a city loses it here, whatever it ships it as — a
 * GeoNames id (Plausible) or a plain name (Umami). */
export const CITY_DROPPED_WARNING = 'city_dropped'

/** Columns the header carried that no report reads. Counted, not named: a column
 * name is provider text and this warning is rendered to the customer. */
export const UNKNOWN_COLUMN_WARNING = 'unknown_columns'

/**
 * Make a provider-supplied dimension value safe to store and to show (D6.3).
 *
 * Three things, in order, and each has a reason:
 *
 * 1. **Control characters are removed**, not escaped. A CSV cell containing a
 *    newline, a NUL or an ANSI escape reaches a dashboard cell, an export file
 *    and an operator's terminal, and every one of those interprets at least one
 *    of them. This is the same rule the collector applies to element text.
 * 2. **Whitespace is collapsed and trimmed**, so `"Chrome  "` and `"Chrome"` are
 *    one dimension value rather than two rows the merge would show twice.
 * 3. **The length is capped.** A hostile export could otherwise mint megabyte
 *    dimension values that survive into every later export of the same site.
 *
 * Deliberately *not* PII redaction: these are dimension names the provider
 * already aggregated, and running the digit-run redactor over them would rewrite
 * legitimate values like `windows 10` or a page path containing an order number
 * the customer chose to keep.
 */
export interface ScrubbedDimension {
  readonly value: string
  /** True when the byte cap cut the value. The adapter counts these so the
   * reviewer is told, with the same ceremony the dropped city column gets: a
   * silent loss is the failure mode, not the loss itself. */
  readonly truncated: boolean
}

export function scrubImportDimension(value: string): string {
  return scrubImportDimensionDetailed(value).value
}

export function scrubImportDimensionDetailed(value: string): ScrubbedDimension {
  let cleaned = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    // C0, DEL and C1. Replaced with a space rather than removed so two words do
    // not fuse into one when a provider used a control character as a separator.
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      cleaned += ' '
      continue
    }
    cleaned += char
  }
  const collapsed = cleaned.replace(/\s+/g, ' ').trim()

  // **Measured in bytes, cut on a code point.** The cap is a byte budget (see
  // `IMPORT_DIMENSION_MAX_BYTES`), but `String.prototype.slice` counts UTF-16
  // code units — a cut landing between the halves of a surrogate pair leaves a
  // lone surrogate, which is not a character: `JSON.stringify` emits it as an
  // unpaired `\ud83d`, the ClickHouse client sends invalid UTF-8, and the
  // dashboard renders a replacement glyph. So the budget is spent per code point
  // and the value is cut between characters or not at all.
  const encoder = new TextEncoder()
  if (encoder.encode(collapsed).length <= IMPORT_DIMENSION_MAX_BYTES) {
    return { value: collapsed, truncated: false }
  }

  // The sentinel has to fit *inside* the cap, not beside it, or a truncated
  // value would be the one thing over budget.
  const budget = IMPORT_DIMENSION_MAX_BYTES - encoder.encode(IMPORT_TRUNCATION_SENTINEL).length
  let bytes = 0
  let cut = ''
  for (const char of collapsed) {
    const size = encoder.encode(char).length
    if (bytes + size > budget) break
    bytes += size
    cut += char
  }
  return { value: `${cut}${IMPORT_TRUNCATION_SENTINEL}`, truncated: true }
}

/** `YYYY-MM-DD`, and a real calendar date. A provider that ships `2024-02-31`
 * gets a parse failure rather than a row nothing can ever query. */
export function isImportDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) return false
  return parsed.toISOString().slice(0, 10) === value
}

/** The day after `date`, as a calendar date. The cutover default is
 * `max imported date + 1` (D4), and doing that with a `Date` in the worker's
 * local zone would land a day early for half the planet. */
export function nextImportDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  parsed.setUTCDate(parsed.getUTCDate() + 1)
  return parsed.toISOString().slice(0, 10)
}

/** The UTC calendar day an instant falls in — how `first_event_at` becomes the
 * "first live day" the cutover is clamped against (D4). */
export function importDateOf(instant: Date): string {
  return instant.toISOString().slice(0, 10)
}
