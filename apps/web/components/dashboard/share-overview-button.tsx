"use client";

import { Share01Icon } from "hugeicons-react";
import { AnimatePresence } from "motion/react";
import { useParams } from "next/navigation";
import * as React from "react";
import { useAnalyticsFilters } from "@/components/dashboard/filter-context";
import { useAnalyticsInterval } from "@/components/dashboard/interval-context";
import { OverviewPosterModal } from "@/components/dashboard/overview-poster-modal";
import {
  posterKey,
  useOverviewPosterStore,
} from "@/components/dashboard/overview-poster-store";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The overview header's Share button: opens the poster modal once the stat
 * row has published numbers for the screen's current range.
 *
 * Disabled with a reason rather than silently: a range still loading, a
 * true empty and a pipeline that is behind are three different answers to
 * "why not", and the one thing this must never do is hand somebody a
 * picture of numbers the card itself is still caveating.
 */
export function ShareOverviewButton() {
  const params = useParams<{ site: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";
  const { range, rangePending } = useAnalyticsInterval();
  const { filtersParam } = useAnalyticsFilters();
  const store = useOverviewPosterStore();
  const [open, setOpen] = React.useState(false);

  const key = posterKey(slug, range, filtersParam);
  const totals =
    !rangePending && store.totals?.key === key ? store.totals : null;
  const reason =
    totals === null
      ? "Waiting for the numbers"
      : totals.state === "empty"
        ? "Nothing to share yet"
        : totals.state !== "ok"
          ? "The numbers are still catching up"
          : null;

  // `aria-disabled` rather than `disabled`: a disabled button takes no
  // pointer events, and the tooltip is the whole point of the state.
  const button = (
    <Button
      aria-disabled={reason !== null}
      className={cn(reason !== null && "opacity-50")}
      onClick={() => {
        if (reason === null) setOpen(true);
      }}
      size="sm"
      variant="outline"
    >
      <Share01Icon aria-hidden="true" />
      Share
    </Button>
  );

  return (
    <>
      {reason === null ? (
        button
      ) : (
        <Tooltip>
          <TooltipTrigger render={button} />
          <TooltipPopup>{reason}</TooltipPopup>
        </Tooltip>
      )}
      <AnimatePresence>
        {open ? <OverviewPosterModal onClose={() => setOpen(false)} /> : null}
      </AnimatePresence>
    </>
  );
}
