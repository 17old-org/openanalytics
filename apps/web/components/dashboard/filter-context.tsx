"use client";

import * as React from "react";
import { useAnalyticsInterval } from "@/components/dashboard/interval-context";
import { Button } from "@/components/ui/button";
import {
  parseFilters,
  serializeFilters,
  withFilterValue,
  withoutFilterDimension,
  withoutFilterValues,
  type FilterClause,
  type FilterDimension,
} from "@/lib/analytics-filters";
import { cn } from "@/lib/utils";

/**
 * The overview screen's active session filter (ADR-0075): one provider per
 * screen, the same shape as the interval: every filtered card reads the
 * same clauses, so adding a chip refetches them together.
 *
 * **The URL is the durable copy.** The serialized `filters` value is written
 * into the page URL verbatim, so a filtered view survives a reload and can
 * be pasted to a teammate; the server normalizes clause and value order
 * internally, so two orders of the same chips are one cache entry and the
 * shared link is cheap for its second reader. The write goes through
 * `history.replaceState` rather than the router: nothing about the route
 * changes, no server component needs to re-render, and reading the initial
 * value straight off `location.search` keeps `useSearchParams`, and the
 * Suspense boundary it demands, out of the tree entirely.
 *
 * The chips themselves render in the tab bar's filter tray (`TabBar`),
 * which is why the provider sits in the site layout: the cards and the bar
 * are different trees, and this is the one ancestor both share.
 *
 * Screens without the provider (the share board) get the inert fallback:
 * no chips, `addFilter` refuses, and the rows that would add one render as
 * plain rows. Filtering is a capability the screen declares, not a default
 * every list inherits.
 */

type FilterContextValue = {
  clauses: readonly FilterClause[];
  /** The wire value for the six filtered reads; `undefined` = unfiltered. */
  filtersParam: string | undefined;
  /** Whether anything is active: the empty-state and chip-row switch. */
  active: boolean;
  /** Whether this screen filters at all; rows read it to become clickable. */
  enabled: boolean;
  /**
   * Whether a value is already in its dimension's clause. A row asks before
   * offering itself: adding what is already there is a no-op, and a row that
   * underlines and takes the press anyway claims to do something it will not.
   * Under an active filter the card is redrawn from the filtered read, so the
   * rows still standing are largely the ones already selected, which is
   * exactly where the empty press would land.
   */
  hasValue: (dimension: FilterDimension, value: string) => boolean;
  addFilter: (dimension: FilterDimension, value: string) => void;
  /** One chip's remove: the values it stands for, the dimension kept. */
  removeValues: (dimension: FilterDimension, values: readonly string[]) => void;
  removeDimension: (dimension: FilterDimension) => void;
  clearFilters: () => void;
};

const INERT: FilterContextValue = {
  clauses: [],
  filtersParam: undefined,
  active: false,
  enabled: false,
  hasValue: () => false,
  addFilter: () => {},
  removeValues: () => {},
  removeDimension: () => {},
  clearFilters: () => {},
};

const FilterContext = React.createContext<FilterContextValue>(INERT);

export function useAnalyticsFilters(): FilterContextValue {
  return React.useContext(FilterContext);
}

const subscribeNever = () => () => {};

export function FilterProvider({ children }: { children: React.ReactNode }) {
  /**
   * The URL's filters, read once. Cached in a ref so the snapshot stays
   * identical across renders, because our own `replaceState` writes would
   * otherwise change it mid-life and trip React's snapshot-consistency
   * check. The server snapshot is `null` (no URL to read), and the
   * post-hydration pass picks the real value up, the same pattern the
   * interval's storage read uses: no mismatch, no flash of someone else's
   * filters.
   */
  const initialRef = React.useRef<string | null>(null);
  const initialSearch = React.useSyncExternalStore(
    subscribeNever,
    () => {
      if (initialRef.current === null) {
        initialRef.current = window.location.search;
      }
      return initialRef.current;
    },
    () => null
  );
  const fromUrl = React.useMemo(
    () =>
      initialSearch === null
        ? []
        : parseFilters(new URLSearchParams(initialSearch).get("filters")),
    [initialSearch]
  );

  // `null` = never edited this visit: the URL's value applies. Edits take
  // over from the first one and the URL follows them from then on.
  const [edited, setEdited] = React.useState<readonly FilterClause[] | null>(
    null
  );
  const clauses = edited ?? fromUrl;
  const filtersParam = React.useMemo(
    () => serializeFilters(clauses),
    [clauses]
  );

  const writeUrl = React.useCallback((next: readonly FilterClause[]) => {
    const url = new URL(window.location.href);
    const serialized = serializeFilters(next);
    if (serialized === undefined) url.searchParams.delete("filters");
    else url.searchParams.set("filters", serialized);
    window.history.replaceState(window.history.state, "", url);
  }, []);

  const hasValue = React.useCallback(
    (dimension: FilterDimension, value: string) =>
      clauses.some(
        (clause) =>
          clause.dimension === dimension && clause.values.includes(value)
      ),
    [clauses]
  );

  const addFilter = React.useCallback(
    (dimension: FilterDimension, value: string) => {
      setEdited((current) => {
        const base = current ?? fromUrl;
        const next = withFilterValue(base, dimension, value);
        if (next !== base) writeUrl(next);
        return next;
      });
    },
    [fromUrl, writeUrl]
  );

  const removeValues = React.useCallback(
    (dimension: FilterDimension, values: readonly string[]) => {
      setEdited((current) => {
        const next = withoutFilterValues(current ?? fromUrl, dimension, values);
        writeUrl(next);
        return next;
      });
    },
    [fromUrl, writeUrl]
  );

  const removeDimension = React.useCallback(
    (dimension: FilterDimension) => {
      setEdited((current) => {
        const next = withoutFilterDimension(current ?? fromUrl, dimension);
        writeUrl(next);
        return next;
      });
    },
    [fromUrl, writeUrl]
  );

  const clearFilters = React.useCallback(() => {
    setEdited([]);
    writeUrl([]);
  }, [writeUrl]);

  const value = React.useMemo(
    () => ({
      clauses,
      filtersParam,
      active: clauses.length > 0,
      enabled: true,
      hasValue,
      addFilter,
      removeValues,
      removeDimension,
      clearFilters,
    }),
    [
      clauses,
      filtersParam,
      hasValue,
      addFilter,
      removeValues,
      removeDimension,
      clearFilters,
    ]
  );

  return (
    <FilterContext.Provider value={value}>{children}</FilterContext.Provider>
  );
}

/* --------------------------------------------------------------------- */
/* The RANGE_TOO_LARGE recovery                                          */
/* --------------------------------------------------------------------- */

/**
 * What a filtered card shows for `400 RANGE_TOO_LARGE`, in place of the
 * generic error panel. A filtered read is answered from the event and
 * session facts rather than a rollup, so it covers at most 92 days while
 * the unfiltered report answers a year. Which means there are exactly two
 * honest ways out, and both are buttons: narrow to the last 90 days with
 * the chips kept, or clear the chips and keep the range. Neither is "try
 * again", because the same request would refuse the same way.
 */
export function FilteredRangePanel({ className }: { className?: string }) {
  const { setInterval } = useAnalyticsInterval();
  const { clearFilters } = useAnalyticsFilters();

  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center gap-2 px-6 py-8 text-center",
        className
      )}
      role="alert"
    >
      <p className="text-sm font-medium">Too long for a filtered view</p>
      <p className="max-w-72 text-sm leading-6 text-muted-foreground">
        A filtered view covers at most 92 days. The full range is still there
        without the filters.
      </p>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
        <Button
          onClick={() => setInterval("90d")}
          size="sm"
          variant="secondary"
        >
          Show the last 90 days
        </Button>
        <Button onClick={clearFilters} size="sm" variant="ghost">
          Clear filters
        </Button>
      </div>
    </div>
  );
}
