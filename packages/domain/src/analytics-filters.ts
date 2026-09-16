/**
 * The dashboard filter grammar (ADR-0075, D-F1 … D-F5).
 *
 * One grammar, defined once, in the package both the API and the query gateway
 * already depend on — so the dashboard, `/v1/read` and MCP cannot drift into
 * three dialects of the same idea.
 *
 * ## The grain rule, which is the decision everything else follows from (D-F1)
 *
 * **A filter selects sessions, and the report then describes everything those
 * sessions did.**
 *
 * Every dimension here is an *acquisition or visitor* attribute — where the
 * visit came from, and who was making it — and those are properties of the
 * visit, not of each page inside it. A visitor who arrives from YouTube and
 * reads five pages must show five pages under `Source: youtube.com`. Filtering
 * pageviews instead would show one, because only the landing pageview carries
 * the referrer, and the customer would conclude that YouTube sends people who
 * bounce. That is not a rounding difference: it is the opposite of the truth.
 *
 * This is the Plausible model, and it is why the predicate lives on
 * `session_facts_versions` — the fact table whose own schema comment says it
 * carries "entry attribution/geo/device dimensions, cheap and low-cardinality,
 * so a session-scoped source/geo/device breakdown does not need a raw join".
 *
 * Content attributes — a page path, a custom event name — are event-scoped and
 * are NOT in this vocabulary. When they arrive they will be a second clause
 * kind, and the ADR says so, because "filter by page" means something different
 * ("sessions that touched this page" vs "pageviews of this page") and the
 * difference has to be decided rather than inherited.
 *
 * ## What v1 accepts (D-F2)
 *
 * Four dimensions, `eq` and `in`, combined with **AND only**. No OR across
 * dimensions, no regex, no free text, no negation. Within one dimension the
 * values are an OR, which is what `in` is — so a chip row that names two
 * countries means "either", and two clauses on the same dimension are merged
 * into one rather than intersected to nothing.
 *
 * The vocabulary is closed and an unknown dimension is refused **by name**
 * (D-F5), never ignored: a filter that is silently dropped answers a question
 * nobody asked with numbers that look right.
 *
 * ## What a fifth dimension costs
 *
 * A data change here plus a column on the fact table, and nothing else: the
 * gateway builds its predicate block by walking `FILTER_DIMENSIONS`, so the SQL
 * is still a module-load constant and no statement has to be edited. That
 * property is the point of the shape (D-F3) rather than a happy accident.
 */

/**
 * The dimensions a filter may name, in the order a normalized filter set lists
 * them.
 *
 * Every one of them is a column of `session_facts_versions`. `city` was added
 * to that table by ClickHouse migration 0023 for exactly this reason — a filter
 * dimension the fact table does not carry cannot be answered from the fact
 * table at all.
 */
export const FILTER_DIMENSIONS = ['referrer_domain', 'country', 'city', 'device_type'] as const

export type FilterDimension = (typeof FILTER_DIMENSIONS)[number]

export const FILTER_OPERATORS = ['eq', 'in'] as const

export type FilterOperator = (typeof FILTER_OPERATORS)[number]

/** One clause. `eq` is `in` with a single value and collapses to it on bind. */
export interface AnalyticsFilter {
  readonly dimension: FilterDimension
  readonly operator: FilterOperator
  readonly values: readonly string[]
}

/** Clauses per request. One per dimension is the ceiling, because they merge. */
export const MAX_FILTER_CLAUSES = FILTER_DIMENSIONS.length

/**
 * Values per dimension.
 *
 * Bounded because the values reach ClickHouse as a constant array the planner
 * evaluates per row, and because a chip row with two hundred countries in it is
 * a client bug rather than a question.
 */
export const MAX_FILTER_VALUES = 20

/** Longest single value. A referrer host, a country code, a city, a device class. */
export const MAX_FILTER_VALUE_LENGTH = 128

export function isFilterDimension(value: unknown): value is FilterDimension {
  return typeof value === 'string' && (FILTER_DIMENSIONS as readonly string[]).includes(value)
}

export function isFilterOperator(value: unknown): value is FilterOperator {
  return typeof value === 'string' && (FILTER_OPERATORS as readonly string[]).includes(value)
}

/**
 * Why a filter set was refused.
 *
 * `dimension` is populated for the one case a client can actually act on
 * without reading prose — it named something this build does not have — and
 * `supported` travels with it so the recovery does not need a second request.
 * D-F5: refuse by name, never hang, never silently ignore.
 */
export interface FilterRefusal {
  readonly ok: false
  readonly message: string
  readonly dimension?: string
  readonly operator?: string
  readonly supported?: readonly string[]
}

export interface FilterAcceptance {
  readonly ok: true
  readonly filters: readonly AnalyticsFilter[]
}

export type FilterParseResult = FilterAcceptance | FilterRefusal

/**
 * Normalizes a filter set into its canonical form.
 *
 * Two things depend on this being canonical rather than merely valid:
 *
 * - **The cache key.** The gateway keys its cache on the bound parameter map, so
 *   two requests that differ only in the order a user clicked their chips must
 *   produce the same bytes or a shared filtered link is a cache miss for every
 *   reader after the first.
 * - **Merging.** Two clauses on one dimension are unioned, not intersected.
 *   `country = US AND country = CA` is empty and is never what a chip row meant.
 *
 * Clauses come out in `FILTER_DIMENSIONS` order, values sorted and deduplicated,
 * and the operator is `eq` exactly when one value survived.
 */
export function normalizeFilters(filters: readonly AnalyticsFilter[]): readonly AnalyticsFilter[] {
  const byDimension = new Map<FilterDimension, Set<string>>()
  for (const filter of filters) {
    const existing = byDimension.get(filter.dimension) ?? new Set<string>()
    for (const value of filter.values) existing.add(value)
    byDimension.set(filter.dimension, existing)
  }

  const normalized: AnalyticsFilter[] = []
  for (const dimension of FILTER_DIMENSIONS) {
    const values = byDimension.get(dimension)
    if (values === undefined || values.size === 0) continue
    const sorted = [...values].sort()
    normalized.push({
      dimension,
      operator: sorted.length === 1 ? 'eq' : 'in',
      values: sorted,
    })
  }
  return normalized
}

/**
 * Parses the wire form: a JSON array of `{dimension, operator, values}`.
 *
 * JSON rather than a compact `dimension:op:value` string, and that is a
 * deliberate trade of URL prettiness for one property: a city name may contain a
 * comma, a colon and an apostrophe (`N'Djamena`), and a delimiter-based syntax
 * would need an escaping rule that the frontend, `/v1/read` and MCP would each
 * have to implement identically. JSON already has one.
 *
 * An **absent** parameter is the empty set rather than an error — every caller
 * written before filters existed keeps working, and an unfiltered read must stay
 * on the rollups (D-F4). A *present* but malformed one is refused, because the
 * caller believed it was filtering and silently would not have been.
 */
export function parseAnalyticsFilters(raw: string | undefined | null): FilterParseResult {
  if (raw === undefined || raw === null || raw.trim() === '') return { ok: true, filters: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, message: 'filters must be a JSON array of {dimension, operator, values}' }
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, message: 'filters must be a JSON array of {dimension, operator, values}' }
  }
  if (parsed.length > MAX_FILTER_CLAUSES) {
    return {
      ok: false,
      message: `filters accepts at most ${MAX_FILTER_CLAUSES} clauses, one per dimension`,
    }
  }

  const filters: AnalyticsFilter[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, message: 'each filter must be an object {dimension, operator, values}' }
    }
    const clause = entry as Record<string, unknown>
    const dimension = clause['dimension']
    if (!isFilterDimension(dimension)) {
      return {
        ok: false,
        message: `unsupported filter dimension: ${describe(dimension)}`,
        dimension: typeof dimension === 'string' ? dimension : describe(dimension),
        supported: FILTER_DIMENSIONS,
      }
    }
    const operator = clause['operator'] ?? 'in'
    if (!isFilterOperator(operator)) {
      return {
        ok: false,
        message: `unsupported filter operator: ${describe(operator)}`,
        operator: typeof operator === 'string' ? operator : describe(operator),
        supported: FILTER_OPERATORS,
      }
    }

    const rawValues = clause['values']
    if (!Array.isArray(rawValues) || rawValues.length === 0) {
      return {
        ok: false,
        message: `filter on ${dimension} must carry at least one value`,
        dimension,
      }
    }
    if (rawValues.length > MAX_FILTER_VALUES) {
      return {
        ok: false,
        message: `filter on ${dimension} accepts at most ${MAX_FILTER_VALUES} values`,
        dimension,
      }
    }
    if (operator === 'eq' && rawValues.length !== 1) {
      return {
        ok: false,
        message: `filter on ${dimension} uses eq, which takes exactly one value — use in`,
        dimension,
        operator,
      }
    }

    const values: string[] = []
    for (const value of rawValues) {
      if (typeof value !== 'string' || value.length > MAX_FILTER_VALUE_LENGTH) {
        return {
          ok: false,
          message: `filter values on ${dimension} must be strings of at most ${MAX_FILTER_VALUE_LENGTH} characters`,
          dimension,
        }
      }
      values.push(value)
    }

    filters.push({ dimension, operator, values })
  }

  return { ok: true, filters: normalizeFilters(filters) }
}

function describe(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
}

/** Whether a read carries any filter at all — the D-F4 routing question. */
export function hasActiveFilters(filters: readonly AnalyticsFilter[]): boolean {
  return filters.some((filter) => filter.values.length > 0)
}

/**
 * The values bound for one dimension, or an empty list when it is not filtered.
 *
 * The gateway binds **every** dimension on every filtered read — an inactive one
 * as an empty list beside an `_on = 0` flag — because its definition checker
 * rejects an unbound placeholder and a bound-but-unused parameter with equal
 * loudness, and because a statement whose shape depends on the request is a
 * statement that is no longer a module-load constant (D-F3).
 */
export function filterValuesFor(
  filters: readonly AnalyticsFilter[],
  dimension: FilterDimension,
): readonly string[] {
  return filters.find((filter) => filter.dimension === dimension)?.values ?? []
}

/** A stable, human-readable rendering, for logs and error details. */
export function describeFilters(filters: readonly AnalyticsFilter[]): string {
  return normalizeFilters(filters)
    .map((filter) => `${filter.dimension} ${filter.operator} [${filter.values.join(', ')}]`)
    .join(' AND ')
}
