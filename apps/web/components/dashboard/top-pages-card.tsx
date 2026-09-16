"use client";

import { ArrowDown01Icon, File01Icon } from "hugeicons-react";
import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import {
  AnalyticsCardBody,
  useSiteAnalytics,
} from "@/components/dashboard/analytics-card";
import { useAnalyticsFilters } from "@/components/dashboard/filter-context";
import { HoverList, HoverRow } from "@/components/dashboard/hover-list";
import {
  SeeAllModal,
  SeeAllSkeleton,
  useIntervalLabel,
} from "@/components/dashboard/see-all-modal";
import {
  DropdownMenu,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  SquircleCard,
  SquircleCardScroll,
} from "@/components/ui/squircle-card";
import {
  getAnalyticsPages,
  LIVE_API,
  type PageRow,
  type PagesSort,
} from "@/lib/api";
import { MOCK_PAGES } from "@/lib/mock";

/**
 * Top pages, from `GET /v1/sites/{site_id}/analytics/pages`, and, behind
 * the header dropdown, the same read ranked as entry pages or exit pages
 * (ADR-0075 §3).
 *
 * **The dropdown changes the request, not the array.** The server returns
 * the top N *by the sorted measure*, and the cut and the sort are one
 * decision: a top-100-by-views page re-sorted by exits client-side would
 * present that page's biggest exits as the site's biggest exits, and the
 * checkout-confirmation page (a busy exit, a quiet view) would be missing
 * from it entirely. So picking a cut sends `?sort=` and the ranking comes
 * back whole.
 *
 * **`null` is not zero.** The four session fields are nullable, and `null`
 * means "not measured on this response": an imported row, or a surface
 * that does not ask. `0` is a measurement: no session began or ended here.
 * The two render differently on purpose: a dash for null, a zero for zero.
 *
 * Brings its own SquircleCard: the header carries the cut picker and
 * "See all" opens the vertical modal, both of which need card state.
 */

const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;

type PagesView = "pages" | "entries" | "exits";

const VIEWS: {
  id: PagesView;
  label: string;
  sort: PagesSort;
  /** What the number column holds in this cut. */
  measure: (page: PageRow) => number | null;
  modalColumns: [string, string];
}[] = [
  {
    id: "pages",
    label: "Top pages",
    sort: "views",
    measure: (page) => page.visitors,
    modalColumns: ["Views", "Visitors"],
  },
  {
    id: "entries",
    label: "Entry pages",
    sort: "entrances",
    measure: (page) => page.entrances,
    modalColumns: ["Entries", "Bounce"],
  },
  {
    id: "exits",
    label: "Exit pages",
    sort: "exits",
    measure: (page) => page.exits,
    modalColumns: ["Exits", "Views"],
  },
];

/**
 * A nullable measure, rendered by the null-is-not-zero rule: a dash for
 * "not measured on this response", the number (zero included) for a
 * measurement. An en dash, not a hyphen: it reads as a mark rather than
 * as punctuation at this size.
 */
function measureLabel(value: number | null): string {
  return value === null ? "–" : value.toLocaleString("en-US");
}

/** `bounce_rate` is `[0,1]` with its denominator on the same row; a null
 *  rate with zero entrances is correct, not missing data. */
function rateLabel(value: number | null): string {
  return value === null ? "–" : `${Math.round(value * 100)}%`;
}

export function TopPagesCard() {
  const { active, filtersParam } = useAnalyticsFilters();
  const [view, setView] = React.useState<PagesView>("pages");
  const current = VIEWS.find((entry) => entry.id === view) ?? VIEWS[0];

  const resource = useSiteAnalytics(getAnalyticsPages, MOCK_PAGES, {
    filters: filtersParam,
    sort: current.sort,
  });
  const [open, setOpen] = React.useState(false);

  /**
   * The mock branch alone re-sorts client-side. The rule above is about a
   * top-N cut of a larger population; the fixture IS its whole population,
   * so sorting it is honest, and without this a board with no api behind
   * it would change the numbers but never the order, which reads as broken.
   */
  const orderRows = React.useCallback(
    (rows: PageRow[]): PageRow[] => {
      if (LIVE_API || current.sort === "views") return rows;
      return [...rows].sort(
        (a, b) => (current.measure(b) ?? -1) - (current.measure(a) ?? -1)
      );
    },
    [current]
  );

  return (
    <>
      <SquircleCard
        icon={<File01Icon aria-hidden="true" />}
        onSeeAll={() => setOpen(true)}
        title={
          <DropdownMenu
            align="start"
            className="w-40"
            trigger={
              <button
                className="flex cursor-pointer items-center gap-1 rounded-lg py-0.5 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
              >
                {/* the house label swap: the title glides on cut change */}
                <AnimatePresence initial={false} mode="popLayout">
                  <motion.span
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: -9, opacity: 0, transition: { duration: 0.1 } }}
                    initial={{ y: 9, opacity: 0 }}
                    key={current.id}
                    transition={SPRING}
                  >
                    {current.label}
                  </motion.span>
                </AnimatePresence>
                <ArrowDown01Icon
                  aria-hidden="true"
                  className="!size-3.5 text-muted-foreground/70"
                />
              </button>
            }
          >
            {VIEWS.map((entry) => (
              <DropdownMenuItem
                key={entry.id}
                onClick={() => setView(entry.id)}
              >
                {entry.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenu>
        }
      >
        <AnalyticsCardBody
          emptyBody={
            active
              ? "No visits match these filters."
              : "No pageviews in this range yet."
          }
          isEmpty={(data) => data.items.length === 0}
          resource={resource}
        >
          {(data) => (
            <AnimatePresence initial={false} mode="wait">
              <motion.div
                animate={{ opacity: 1, y: 0 }}
                className="h-full"
                exit={{ opacity: 0, y: -6, transition: { duration: 0.1 } }}
                initial={{ opacity: 0, y: 8 }}
                key={view}
                transition={SPRING}
              >
                <SquircleCardScroll>
                  <HoverList>
                    {orderRows(data.items).map((page) => (
                      <HoverRow key={page.page_path}>
                        <div className="flex items-center justify-between gap-4 px-5 py-1.5">
                          <span
                            aria-hidden="true"
                            className="size-2 shrink-0 rounded-full bg-primary/50 transition-colors group-hover:bg-primary"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm">
                              {page.page_path}
                            </span>
                          </span>
                          <span className="text-sm tabular-nums text-muted-foreground">
                            {measureLabel(current.measure(page))}
                          </span>
                        </div>
                      </HoverRow>
                    ))}
                  </HoverList>
                </SquircleCardScroll>
              </motion.div>
            </AnimatePresence>
          )}
        </AnalyticsCardBody>
      </SquircleCard>

      <AnimatePresence>
        {open && (
          <TopPagesModal
            onClose={() => setOpen(false)}
            pages={
              resource.status === "ready"
                ? orderRows(resource.data.items)
                : null
            }
            view={current}
          />
        )}
      </AnimatePresence>
    </>
  );
}

/** The modal's two numeric cells for one row, by the cut being shown. */
function modalCells(view: PagesView, page: PageRow): [string, string] {
  if (view === "entries") {
    return [measureLabel(page.entrances), rateLabel(page.bounce_rate)];
  }
  if (view === "exits") {
    return [measureLabel(page.exits), measureLabel(page.views)];
  }
  return [
    page.views.toLocaleString("en-US"),
    page.visitors.toLocaleString("en-US"),
  ];
}

const MODAL_SUBTITLE: Record<PagesView, string> = {
  pages: "Every page your visitors opened",
  entries: "Where visits began, and how many left from there",
  exits: "The last page of each visit",
};

function TopPagesModal({
  pages,
  view,
  onClose,
}: {
  pages: PageRow[] | null;
  view: (typeof VIEWS)[number];
  onClose: () => void;
}) {
  const intervalLabel = useIntervalLabel();
  return (
    <SeeAllModal
      title={view.label}
      subtitle={`${MODAL_SUBTITLE[view.id]} · ${intervalLabel}`}
      onClose={onClose}
    >
      {pages === null ? (
        <SeeAllSkeleton />
      ) : (
        <div>
          <div className="flex items-center justify-between gap-4 px-3 pb-1.5">
            <span className="text-xs font-medium text-muted-foreground/70">
              Page
            </span>
            <span className="flex items-baseline gap-2">
              {view.modalColumns.map((column) => (
                <span
                  className="w-14 text-right text-xs font-medium text-muted-foreground/70"
                  key={column}
                >
                  {column}
                </span>
              ))}
            </span>
          </div>
          {/* the shared white glide, rounded for the grey band */}
          <HoverList className="[&>li>span]:rounded-[10px]">
            {pages.map((page) => {
              const [first, second] = modalCells(view.id, page);
              return (
                <HoverRow key={page.page_path}>
                  <div className="flex items-center justify-between gap-4 px-3 py-2">
                    <span
                      aria-hidden="true"
                      className="size-2 shrink-0 rounded-full bg-primary/50 transition-colors group-hover:bg-primary"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {page.page_path}
                      </span>
                    </span>
                    <span className="flex items-baseline gap-2">
                      <span className="w-14 text-right text-sm tabular-nums text-muted-foreground">
                        {first}
                      </span>
                      <span className="w-14 text-right text-sm tabular-nums text-muted-foreground/70">
                        {second}
                      </span>
                    </span>
                  </div>
                </HoverRow>
              );
            })}
          </HoverList>
        </div>
      )}
    </SeeAllModal>
  );
}
