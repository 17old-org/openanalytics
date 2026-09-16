"use client";

import * as React from "react";
import { RefreshIcon } from "@/components/icons/hugeicons";
import { Kbd } from "@/components/ui/kbd";
import { requestRefresh } from "@/lib/refresh";
import { cn } from "@/lib/utils";

/**
 * The overview header's refresh: one press (or the `R` key, printed on the
 * button so nobody has to be told) re-runs every read on the screen through
 * the refresh epoch (`lib/refresh.ts`). It exists because the alternative
 * was the browser's own reload, which refetches the entire app to answer a
 * question about one screen's numbers.
 *
 * The spin is feedback for the press, not a progress bar: the reads settle
 * independently and each card already shows its own skeleton while it does,
 * so the icon takes one turn and stops rather than pretending to know when
 * "all of it" is done.
 */
export function RefreshButton() {
  const [spinning, setSpinning] = React.useState(false);

  const refresh = React.useCallback(() => {
    requestRefresh();
    setSpinning(true);
  }, []);

  React.useEffect(() => {
    if (!spinning) return;
    const timer = window.setTimeout(() => setSpinning(false), 600);
    return () => window.clearTimeout(timer);
  }, [spinning]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A bare `r`, and only as a command: not while typing (inputs,
      // textareas, anything editable), not held down, and never when a
      // modifier makes it the browser's (⌘R is the reload this button
      // exists to replace, not to shadow).
      if (event.key !== "r" && event.key !== "R") return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat)
        return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      // Drop whatever still holds focus from an earlier click before acting:
      // the keypress flips the browser into keyboard modality, which would
      // paint a focus ring onto that stale element mid-refresh: an answer
      // ("focus is here") to a question nobody asked. The cost is real and
      // accepted: someone mid-Tab-navigation who presses R loses their
      // position. R is the only key this happens on.
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      refresh();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [refresh]);

  return (
    <button
      aria-label="Refresh the numbers on this screen"
      className="group flex cursor-pointer items-center gap-1.5 rounded-md shadow-xs border border-border px-1.5 py-[3px] text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={refresh}
      title="Refresh (R)"
      type="button"
    >
      {/* One full turn per press (a finite animation, not `animate-spin`,
          which is endless and snaps when cut). Keyed off the class so a
          second press mid-turn restarts it via the state timer. */}
      <RefreshIcon
        aria-hidden="true"
        className={cn(
          "size-3.25",
          spinning && "animate-[spin_0.6s_ease-in-out_1]"
        )}
      />
      {/* The shared Kbd a step under its default: the chip is a hint inside
          an already-small control, not a menu shortcut column. Hidden on a
          phone, where there is no R to press; the button itself stays, since
          tap-to-refresh is exactly what a phone wants. The listener stays
          too, for the hardware keyboards phones and tablets sometimes have;
          only the advertisement is width-gated. */}
      <Kbd className="h-4 min-w-4 rounded-[4px] px-0.5 text-[11px] max-sm:hidden">
        R
      </Kbd>
    </button>
  );
}
