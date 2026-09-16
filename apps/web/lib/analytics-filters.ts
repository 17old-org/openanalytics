/**
 * The session filter model (ADR-0075), shared by the chip row, the URL and
 * every filtered read.
 *
 * The one sentence that decides every number under a filter: **a filter
 * selects sessions, and the report then describes everything those sessions
 * did.** A visitor who arrives from YouTube and reads five pages shows five
 * pages under `Source: youtube.com`, not one: only the landing pageview
 * carries the referrer, and filtering pageviews would report that YouTube
 * sends people who bounce, which is the opposite of the truth.
 *
 * The wire format is a URL-encoded JSON array on one `filters` parameter:
 *
 *     [{"dimension":"country","values":["US","CA"]}]
 *
 * JSON rather than a compact `dimension:op:value` string because a city name
 * can contain a comma, a colon and an apostrophe (N'Djamena), and a delimiter
 * syntax would need an escaping rule the dashboard, `/v1/read` and MCP would
 * each have to implement identically. The operator is omitted on purpose:
 * omitted means `in`, and `in` with one value is `eq`.
 *
 * Combination is AND across dimensions, OR within one. The model below keeps
 * exactly one clause per dimension, which is the same shape the server
 * normalizes to; two clauses on one dimension are merged into one OR anyway,
 * so holding a second would be a lie about what the query says.
 */

export const FILTER_DIMENSIONS = [
  "referrer_domain",
  "country",
  "city",
  "device_type",
] as const;

export type FilterDimension = (typeof FILTER_DIMENSIONS)[number];

/** The server's own caps: values per clause, characters per value. */
const MAX_VALUES_PER_CLAUSE = 20;
const MAX_VALUE_LENGTH = 128;

export type FilterClause = {
  dimension: FilterDimension;
  /** Matched exactly against the session entry. `""` is Direct. */
  values: string[];
};

const isDimension = (value: unknown): value is FilterDimension =>
  FILTER_DIMENSIONS.includes(value as FilterDimension);

/** What the chip row calls each dimension. */
export const DIMENSION_LABEL: Record<FilterDimension, string> = {
  referrer_domain: "Source",
  country: "Country",
  city: "City",
  device_type: "Device",
};

/**
 * Region names for the country chips, resolved lazily: `Intl.DisplayNames`
 * can throw where ICU data is missing, and a chip that says `DE` in that
 * one environment beats a chip row that crashes in it.
 */
let regionNames: Intl.DisplayNames | null | undefined;
function countryLabel(code: string): string {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  if (regionNames === null) return code;
  try {
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/**
 * What a chip shows for one value. The wire value is what the session entry
 * stores (the ISO code, the raw token, the canonical host) and never changes;
 * this is only how the chip spells it, which is why a country reads
 * "Germany" while the filter still says `DE`. The empty referrer is Direct
 * by contract.
 */
export function filterValueLabel(
  dimension: FilterDimension,
  value: string
): string {
  if (dimension === "referrer_domain" && value === "") return "Direct";
  if (dimension === "country") return countryLabel(value);
  if (dimension === "device_type") {
    const device: Record<string, string> = {
      desktop: "Desktop",
      mobile: "Mobile",
      tablet: "Tablet",
      unknown: "Other",
    };
    return device[value] ?? value;
  }
  return value;
}

/**
 * The `filters` query value for a clause set, or `undefined` for none. And
 * `undefined` matters: an absent parameter is the unfiltered read at its
 * unfiltered cost, while an empty array would still be a parameter to parse.
 * The clause and value order is left as-is; the server normalizes internally,
 * so two orders of the same chips are one cache entry without the client
 * sorting anything.
 */
export function serializeFilters(
  clauses: readonly FilterClause[]
): string | undefined {
  if (clauses.length === 0) return undefined;
  return JSON.stringify(
    clauses.map((clause) => ({
      dimension: clause.dimension,
      values: clause.values,
    }))
  );
}

/**
 * Clauses from a raw `filters` query value (already URL-decoded by
 * `URLSearchParams`). Anything malformed folds to no filters rather than
 * throwing: the string arrives from a shared or hand-edited URL, and a page
 * that crashes on a bad link is worse than one that opens unfiltered.
 * Unknown dimensions are dropped clause by clause, so a link written against
 * a future dimension still applies the ones this build knows.
 */
export function parseFilters(raw: string | null): FilterClause[] {
  if (raw === null || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const byDimension = new Map<FilterDimension, string[]>();
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const { dimension, values } = entry as {
      dimension?: unknown;
      values?: unknown;
    };
    if (!isDimension(dimension) || !Array.isArray(values)) continue;
    const clean = values
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.slice(0, MAX_VALUE_LENGTH));
    if (clean.length === 0) continue;
    // Two clauses on one dimension merge into one OR, the server's own
    // normalization, applied here so the chips show what the query means.
    const existing = byDimension.get(dimension) ?? [];
    for (const value of clean) {
      if (!existing.includes(value)) existing.push(value);
    }
    byDimension.set(dimension, existing.slice(0, MAX_VALUES_PER_CLAUSE));
  }
  return [...byDimension.entries()].map(([dimension, values]) => ({
    dimension,
    values,
  }));
}

/**
 * A clause set with `value` added to `dimension`'s OR, which is the row-click
 * operation. Adding a value that is already present returns the set
 * unchanged (same reference, so callers can skip a no-op update), and a
 * clause at the value cap stays as it is rather than silently dropping one.
 */
export function withFilterValue(
  clauses: readonly FilterClause[],
  dimension: FilterDimension,
  value: string
): readonly FilterClause[] {
  const clean = value.slice(0, MAX_VALUE_LENGTH);
  const existing = clauses.find((clause) => clause.dimension === dimension);
  if (existing) {
    if (existing.values.includes(clean)) return clauses;
    if (existing.values.length >= MAX_VALUES_PER_CLAUSE) return clauses;
    return clauses.map((clause) =>
      clause.dimension === dimension
        ? { dimension, values: [...clause.values, clean] }
        : clause
    );
  }
  return [...clauses, { dimension, values: [clean] }];
}

/**
 * The set without some values of one dimension: a single chip's remove
 * while its dimension still holds others. A clause emptied this way is
 * dropped whole, because a clause with no values is not "match nothing",
 * it is a parameter the server would refuse.
 */
export function withoutFilterValues(
  clauses: readonly FilterClause[],
  dimension: FilterDimension,
  values: readonly string[]
): readonly FilterClause[] {
  return clauses.flatMap((clause) => {
    if (clause.dimension !== dimension) return [clause];
    const kept = clause.values.filter((value) => !values.includes(value));
    return kept.length === 0 ? [] : [{ dimension, values: kept }];
  });
}

/** The set without one dimension: the folded chip's remove. */
export function withoutFilterDimension(
  clauses: readonly FilterClause[],
  dimension: FilterDimension
): readonly FilterClause[] {
  return clauses.filter((clause) => clause.dimension !== dimension);
}
