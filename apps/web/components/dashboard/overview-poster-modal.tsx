"use client";

import {
  Cancel01Icon,
  Copy01Icon,
  Download04Icon,
  Moon02Icon,
  Sun03Icon,
  Tick02Icon,
} from "hugeicons-react";
import { motion } from "motion/react";
import { useParams } from "next/navigation";
import * as React from "react";
import { createPortal } from "react-dom";
import { PALETTE } from "@/components/dither-kit/palette";
import { useAnalyticsFilters } from "@/components/dashboard/filter-context";
import { FLOW_SPRING } from "@/components/dashboard/flow-dialog";
import { useAnalyticsInterval } from "@/components/dashboard/interval-context";
import {
  posterKey,
  useOverviewPosterStore,
} from "@/components/dashboard/overview-poster-store";
import { useIntervalLabel } from "@/components/dashboard/see-all-modal";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SquircleSurface } from "@/components/ui/squircle-card";
import { Switch } from "@/components/ui/switch";
import {
  DIMENSION_LABEL,
  filterValueLabel,
  type FilterClause,
} from "@/lib/analytics-filters";
import { formatMoney } from "@/lib/currencies";
import { loadSiteFavicon } from "@/lib/poster/favicon";
import { ensurePosterFonts, posterFontFamily } from "@/lib/poster/fonts";
import {
  drawOverviewPoster,
  POSTER_COLORS,
  POSTER_HEIGHT,
  POSTER_METRICS,
  POSTER_SCALE,
  POSTER_WIDTH,
  posterFileName,
  type PosterColor,
  type PosterLook,
  type PosterMetric,
  type PosterMetricKey,
  type PosterModel,
  type PosterTheme,
} from "@/lib/poster/overview-poster";
import { posterPeriodDates } from "@/lib/poster/period";
import { resolveReferrer } from "@/lib/referrers";
import { cn } from "@/lib/utils";

/**
 * Share as image: the overview's numbers as a 1200×630 poster, drawn in
 * the browser and handed over as a PNG (feature_candidates §6).
 *
 * Everything on the canvas comes from the overview store, which the stat
 * row, the revenue tile and the chart fill as they render. Nothing is
 * fetched here, so the picture can never disagree with the screen, and the
 * preview *is* the file: one canvas, drawn once per change, read back by
 * `toBlob` for the download and the clipboard alike.
 *
 * The choices (look, figures, chart colour, whether the site is named) are
 * the customer's and remembered per browser, the way the interval is.
 * What is not a choice: an active filter is always printed, because
 * filtered visitors under an unqualified headline would present a slice as
 * the whole site.
 */

const PREFS_KEY = "oa:overview-poster:v1";

type PosterPreferences = {
  theme: PosterTheme;
  color: PosterColor;
  chart: boolean;
  hideSite: boolean;
  metrics: readonly PosterMetricKey[];
};

const DEFAULT_PREFS: PosterPreferences = {
  theme: "light",
  color: "blue",
  chart: true,
  hideSite: false,
  metrics: POSTER_METRICS,
};

const isPosterColor = (value: unknown): value is PosterColor =>
  typeof value === "string" && POSTER_COLORS.includes(value as PosterColor);

/** Storage never throws here: a locked-down browser gets the defaults. */
function readPreferences(): PosterPreferences {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_PREFS;
    const record = parsed as Record<string, unknown>;
    const metrics = record.metrics;
    return {
      theme: record.theme === "dark" ? "dark" : "light",
      color: isPosterColor(record.color) ? record.color : "blue",
      chart: record.chart !== false,
      hideSite: record.hideSite === true,
      metrics: Array.isArray(metrics)
        ? POSTER_METRICS.filter((key) => metrics.includes(key))
        : POSTER_METRICS,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writePreferences(prefs: PosterPreferences): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // The choice still applies to this modal; it is simply not remembered.
  }
}

const subscribeNever = () => () => {};

function usePosterPreferences(): [
  PosterPreferences,
  (patch: Partial<PosterPreferences>) => void,
] {
  // Read once and cached, the interval's own storage pattern: the snapshot
  // must stay identical across renders, and this modal's writes would
  // otherwise move it mid-life.
  const storedRef = React.useRef<PosterPreferences | null>(null);
  const stored = React.useSyncExternalStore(
    subscribeNever,
    () => {
      if (storedRef.current === null) storedRef.current = readPreferences();
      return storedRef.current;
    },
    () => DEFAULT_PREFS
  );
  const [edited, setEdited] = React.useState<PosterPreferences | null>(null);
  const update = React.useCallback(
    (patch: Partial<PosterPreferences>) => {
      setEdited((current) => {
        const next = { ...(current ?? stored), ...patch };
        writePreferences(next);
        return next;
      });
    },
    [stored]
  );
  return [edited ?? stored, update];
}

/** "Source: Google, GitHub · Country: Germany", the chip row's own words. */
function filtersLineOf(clauses: readonly FilterClause[]): string | null {
  if (clauses.length === 0) return null;
  return clauses
    .map((clause) => {
      const labels = new Set(
        clause.values.map((value) =>
          clause.dimension === "referrer_domain" && value !== ""
            ? resolveReferrer(value).name
            : filterValueLabel(clause.dimension, value)
        )
      );
      return `${DIMENSION_LABEL[clause.dimension]}: ${[...labels].join(", ")}`;
    })
    .join(" · ");
}

const METRIC_LABEL: Record<PosterMetricKey, string> = {
  visitors: "Visitors",
  pageviews: "Pageviews",
  bounce: "Bounce rate",
  revenue: "Revenue",
};

export function OverviewPosterModal({ onClose }: { onClose: () => void }) {
  const params = useParams<{ site: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";
  const { range } = useAnalyticsInterval();
  const periodLabel = useIntervalLabel();
  const {
    clauses,
    active: filtersActive,
    filtersParam,
  } = useAnalyticsFilters();
  const store = useOverviewPosterStore();
  const [prefs, update] = usePosterPreferences();

  // Only the slices published for *this* screen count; the rest is the
  // previous range still sitting in the store.
  const key = posterKey(slug, range, filtersParam);
  const revenueKey = posterKey(slug, range);
  const totals = store.totals?.key === key ? store.totals : null;
  const sessions = store.sessions?.key === key ? store.sessions : null;
  const revenue = store.revenue?.key === revenueKey ? store.revenue : null;
  const series = store.series?.key === key ? store.series : null;
  const site = store.site?.slug === slug ? store.site : null;

  // Bounce rides the sessions read, which takes no filter; the tile shows a
  // dash under one, so the poster offers nothing there either. Revenue is
  // the same population problem: an unfiltered figure beside filtered
  // counts would read as one row of facts.
  const bounceAvailable =
    !filtersActive && sessions !== null && sessions.bounceRate !== null;
  const revenueOffered = revenue !== null && revenue.netMinor !== null;
  const revenueAvailable = revenueOffered && !filtersActive;
  const chartAvailable = series !== null && series.visitors.length >= 2;

  // The page's own type, loaded before the first draw.
  const family = React.useMemo(() => posterFontFamily(), []);
  const [fontsReady, setFontsReady] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    ensurePosterFonts(family).then(() => {
      if (alive) setFontsReady(true);
    });
    return () => {
      alive = false;
    };
  }, [family]);

  // The site's mark, walked exactly as the switcher walks it.
  const domains = site?.domains ?? null;
  const domainsKey = domains ? domains.join(",") : "";
  const [favicon, setFavicon] = React.useState<{
    key: string;
    image: HTMLImageElement | null;
  } | null>(null);
  React.useEffect(() => {
    if (!domains) return;
    const controller = new AbortController();
    loadSiteFavicon(domains, controller.signal).then((image) => {
      if (!controller.signal.aborted) {
        setFavicon({ key: domains.join(","), image });
      }
    });
    return () => controller.abort();
  }, [domains]);
  const faviconReady = favicon !== null && favicon.key === domainsKey;

  const metrics = React.useMemo<PosterMetric[]>(() => {
    if (!totals) return [];
    const chosen = new Set(prefs.metrics);
    const list: PosterMetric[] = [];
    if (chosen.has("visitors")) {
      list.push({
        key: "visitors",
        label: METRIC_LABEL.visitors,
        value: totals.visitors.toLocaleString("en-US"),
      });
    }
    if (chosen.has("pageviews")) {
      list.push({
        key: "pageviews",
        label: METRIC_LABEL.pageviews,
        value: totals.pageviews.toLocaleString("en-US"),
      });
    }
    if (
      chosen.has("bounce") &&
      bounceAvailable &&
      sessions &&
      sessions.bounceRate !== null
    ) {
      list.push({
        key: "bounce",
        label: METRIC_LABEL.bounce,
        value: `${Math.round(sessions.bounceRate * 100)}%`,
      });
    }
    if (
      chosen.has("revenue") &&
      revenueAvailable &&
      revenue &&
      revenue.netMinor !== null &&
      revenue.currency
    ) {
      list.push({
        key: "revenue",
        label: METRIC_LABEL.revenue,
        value: formatMoney(revenue.netMinor, revenue.currency),
      });
    }
    return list;
  }, [
    totals,
    sessions,
    revenue,
    prefs.metrics,
    bounceAvailable,
    revenueAvailable,
  ]);

  const filtersLine = React.useMemo(() => filtersLineOf(clauses), [clauses]);
  const dates = React.useMemo(() => posterPeriodDates(range), [range]);
  const faviconImage = faviconReady ? favicon.image : null;
  const seriesValues = series?.visitors ?? null;

  const model = React.useMemo<PosterModel | null>(() => {
    if (!totals || !site) return null;
    return {
      site: { name: site.name, favicon: faviconImage },
      period: { label: periodLabel, dates },
      metrics,
      series: seriesValues ?? [],
      filters: filtersLine,
    };
  }, [
    totals,
    site,
    faviconImage,
    periodLabel,
    dates,
    metrics,
    seriesValues,
    filtersLine,
  ]);

  const look = React.useMemo<PosterLook>(
    () => ({
      theme: prefs.theme,
      color: prefs.color,
      chart: prefs.chart && chartAvailable,
      hideSite: prefs.hideSite,
    }),
    [prefs.theme, prefs.color, prefs.chart, prefs.hideSite, chartAvailable]
  );

  const ready =
    model !== null && fontsReady && (prefs.hideSite || faviconReady);

  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    if (!ready || !model) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    drawOverviewPoster(ctx, model, look, family);
  }, [ready, model, look, family]);

  const [note, setNote] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const copiedTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const fileName = posterFileName(site?.name ?? slug, periodLabel);

  const toBlob = React.useCallback(
    () =>
      new Promise<Blob>((resolve, reject) => {
        const canvas = canvasRef.current;
        if (!canvas) {
          reject(new Error("The poster has not been drawn"));
          return;
        }
        canvas.toBlob(
          (blob) =>
            blob ? resolve(blob) : reject(new Error("Empty PNG")),
          "image/png"
        );
      }),
    []
  );

  const download = async () => {
    try {
      const blob = await toBlob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNote(null);
    } catch {
      setNote("The image could not be rendered. Try again.");
    }
  };

  // Feature-detected rather than assumed: Firefox has no `ClipboardItem`
  // for images in every version, and a button that fails on press is
  // worse than a button that is not there.
  const canCopy = React.useSyncExternalStore(
    subscribeNever,
    () =>
      typeof ClipboardItem !== "undefined" &&
      typeof navigator !== "undefined" &&
      typeof navigator.clipboard?.write === "function",
    () => false
  );

  const copy = async () => {
    try {
      // The promise form, and created inside the press: Safari only
      // honours a clipboard write that starts within the user gesture.
      const item = new ClipboardItem({ "image/png": toBlob() });
      await navigator.clipboard.write([item]);
      setNote(null);
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setNote("Copying is blocked here. Download the file instead.");
    }
  };

  const toggleMetric = (metric: PosterMetricKey, on: boolean) => {
    const next = POSTER_METRICS.filter((key) =>
      key === metric ? on : prefs.metrics.includes(key)
    );
    update({ metrics: next });
  };

  return (
    <PosterDialog
      footer={
        <>
          {canCopy ? (
            <Button
              disabled={!ready}
              onClick={copy}
              size="xs"
              variant="outline"
            >
              {copied ? (
                <Tick02Icon aria-hidden="true" />
              ) : (
                <Copy01Icon aria-hidden="true" />
              )}
              {copied ? "Copied" : "Copy image"}
            </Button>
          ) : null}
          <Button disabled={!ready} onClick={download} size="xs">
            <Download04Icon aria-hidden="true" />
            Download PNG
          </Button>
        </>
      }
      onClose={onClose}
      subtitle="The numbers on screen, exactly as they read now."
      title="Share as image"
    >
      <div className="grid gap-5 p-4 sm:p-5 md:grid-cols-[minmax(0,1fr)_14rem]">
        <div className="flex min-w-0 flex-col gap-2">
          <div
            className="relative overflow-hidden rounded-2xl border border-border bg-[#f6f6f6]"
            style={{ aspectRatio: `${POSTER_WIDTH} / ${POSTER_HEIGHT}` }}
          >
            <canvas
              aria-label="Poster preview"
              className={cn("block h-full w-full", !ready && "invisible")}
              height={POSTER_HEIGHT * POSTER_SCALE}
              ref={canvasRef}
              width={POSTER_WIDTH * POSTER_SCALE}
            />
            {!ready ? (
              <div
                aria-hidden="true"
                className="absolute inset-0 animate-pulse bg-muted-foreground/10"
              />
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {filtersActive
              ? "The active filters are printed on the image."
              : `PNG, ${POSTER_WIDTH * POSTER_SCALE} × ${POSTER_HEIGHT * POSTER_SCALE}.`}
          </p>
          {note ? (
            <p className="text-xs text-destructive" role="alert">
              {note}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-5">
          <Section label="Look">
            <div className="grid grid-cols-2 gap-1 rounded-full bg-black/4 p-1">
              {(["light", "dark"] as const).map((theme) => (
                <button
                  aria-pressed={prefs.theme === theme}
                  className={cn(
                    "flex cursor-pointer items-center justify-center gap-1.5 rounded-full py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                    prefs.theme === theme
                      ? "bg-card text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  key={theme}
                  onClick={() => update({ theme })}
                  type="button"
                >
                  {theme === "light" ? (
                    <Sun03Icon aria-hidden="true" className="size-3.5" />
                  ) : (
                    <Moon02Icon aria-hidden="true" className="size-3.5" />
                  )}
                  {theme === "light" ? "Light" : "Dark"}
                </button>
              ))}
            </div>
          </Section>

          <Section label="Numbers">
            <div className="flex flex-col gap-2">
              <MetricRow
                checked={prefs.metrics.includes("visitors")}
                label={METRIC_LABEL.visitors}
                onChange={(on) => toggleMetric("visitors", on)}
              />
              <MetricRow
                checked={prefs.metrics.includes("pageviews")}
                label={METRIC_LABEL.pageviews}
                onChange={(on) => toggleMetric("pageviews", on)}
              />
              <MetricRow
                checked={prefs.metrics.includes("bounce") && bounceAvailable}
                disabled={!bounceAvailable}
                hint={
                  filtersActive
                    ? "Paused while filters are on"
                    : bounceAvailable
                      ? undefined
                      : "Not available"
                }
                label={METRIC_LABEL.bounce}
                onChange={(on) => toggleMetric("bounce", on)}
              />
              {revenueOffered ? (
                <MetricRow
                  checked={
                    prefs.metrics.includes("revenue") && revenueAvailable
                  }
                  disabled={!revenueAvailable}
                  hint={filtersActive ? "Paused while filters are on" : undefined}
                  label={METRIC_LABEL.revenue}
                  onChange={(on) => toggleMetric("revenue", on)}
                />
              ) : null}
              <MetricRow
                checked={prefs.chart && chartAvailable}
                disabled={!chartAvailable}
                hint={chartAvailable ? undefined : "No chart for this range"}
                label="Chart"
                onChange={(on) => update({ chart: on })}
              />
            </div>
          </Section>

          <Section label="Color">
            <div className="flex flex-wrap gap-2">
              {POSTER_COLORS.map((color) => {
                const [r, g, b] = PALETTE[color].fill;
                return (
                  <button
                    aria-label={color[0].toUpperCase() + color.slice(1)}
                    aria-pressed={prefs.color === color}
                    className={cn(
                      "size-7 cursor-pointer rounded-full border-2 outline-none transition-[border-color,transform] hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2",
                      prefs.color === color
                        ? "border-foreground"
                        : "border-transparent"
                    )}
                    key={color}
                    onClick={() => update({ color })}
                    style={{
                      backgroundColor: `rgb(${r}, ${g}, ${b})`,
                      boxShadow: "inset 0 0 0 2px var(--card)",
                    }}
                    type="button"
                  />
                );
              })}
            </div>
          </Section>

          <Section label="Site">
            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0">
                <span className="block">Show the site name</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {site?.name ?? slug}
                </span>
              </span>
              <Switch
                checked={!prefs.hideSite}
                onCheckedChange={(checked: boolean) =>
                  update({ hideSite: !checked })
                }
              />
            </label>
          </Section>
        </div>
      </div>
    </PosterDialog>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

function MetricRow({
  label,
  checked,
  disabled = false,
  hint,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  hint?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "flex items-center gap-2.5 text-sm",
        disabled ? "text-muted-foreground" : "cursor-pointer"
      )}
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next: boolean) => onChange(next)}
      />
      <span className="flex-1">{label}</span>
      {hint ? (
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

/**
 * The flow dialogs' shell, one size up: the same squircle frame on grey,
 * header strip, inset white panel and footer strip, wide enough for a
 * 16:9 preview beside its options. Portaled for the same reason those are.
 */
function PosterDialog({
  title,
  subtitle,
  onClose,
  footer,
  children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <motion.div
        animate={{ opacity: 1 }}
        className="absolute inset-0 bg-black/40"
        exit={{ opacity: 0, transition: { duration: 0.15 } }}
        initial={{ opacity: 0 }}
        key="poster-backdrop"
        onClick={onClose}
      />
      <motion.div
        animate={{ opacity: 1, scale: 1, y: 0 }}
        aria-label={title}
        aria-modal="true"
        className="relative w-full max-w-4xl"
        exit={{ opacity: 0, scale: 0.96, y: -4, transition: { duration: 0.12 } }}
        initial={{ opacity: 0, scale: 0.94, y: -6 }}
        key="poster-card"
        role="dialog"
        transition={FLOW_SPRING}
      >
        {/* the shadow lives on this unclipped wrapper; a clip-path cannot
            clip a box shadow */}
        <div className="rounded-[26px] shadow-[0_1px_2px_rgba(0,0,0,0.06),0_24px_60px_rgba(0,0,0,0.18)] sm:rounded-[50px]">
          <SquircleSurface className="flex max-h-[calc(100svh-2rem)] flex-col rounded-[26px] border border-border bg-[#f6f6f6] p-1 [--card-clip-handle:2.25px] [--card-clip-radius:14px] sm:rounded-[50px] sm:[--card-clip-handle:3px] sm:[--card-clip-radius:20px]">
            <div className="flex h-9 shrink-0 items-center justify-between pl-3.5 pr-1">
              <span className="text-sm font-medium text-foreground/80">
                {title}
              </span>
              <button
                aria-label="Close"
                className="flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-black/6 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onClick={onClose}
                type="button"
              >
                <Cancel01Icon className="size-4" />
              </button>
            </div>

            <SquircleSurface className="min-h-0 overflow-y-auto rounded-[22px] border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:12px] sm:rounded-[44px] sm:[--card-clip-radius:17px]">
              {children}
            </SquircleSurface>

            <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 pb-1 pl-3.5 pr-1 pt-1">
              <p className="text-xs text-muted-foreground">{subtitle}</p>
              <div className="flex items-center gap-2">{footer}</div>
            </div>
          </SquircleSurface>
        </div>
      </motion.div>
    </div>,
    document.body
  );
}
