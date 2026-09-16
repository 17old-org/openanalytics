"use client";

import { motion } from "motion/react";
import { useParams } from "next/navigation";
import * as React from "react";
import { anonName } from "@/components/dashboard/anon-identity";
import { HoverList, HoverRow } from "@/components/dashboard/hover-list";
import {
  secondsSince,
  timeAgo,
  useClockBucket,
} from "@/components/dashboard/realtime-clock";
import {
  RealtimeStatusChip,
  RealtimeStatusNote,
} from "@/components/dashboard/realtime-status";
import {
  SquircleCardScroll,
  useSquircleCardHeaderChip,
} from "@/components/ui/squircle-card";
import { UserAvatar } from "@/components/ui/user-avatar";
import { useRealtime } from "@/hooks/use-realtime";
import { cn } from "@/lib/utils";

/**
 * The live-visitor count, published once for the whole overview screen.
 *
 * Two places wear the same number: the Realtime card's title and the page's
 * "Overview" heading. `useRealtime` opens one SSE stream per caller, so the
 * heading must not subscribe on its own; the card is the screen's one
 * subscriber and hands the count over through this module store. `null`
 * means no snapshot, and the heading badge simply is not there.
 */
let liveNowCount: number | null = null;
const liveNowListeners = new Set<() => void>();

function publishLiveNow(next: number | null): void {
  if (next === liveNowCount) return;
  liveNowCount = next;
  for (const listener of liveNowListeners) listener();
}

function subscribeLiveNow(listener: () => void): () => void {
  liveNowListeners.add(listener);
  return () => liveNowListeners.delete(listener);
}

const readLiveNow = (): number | null => liveNowCount;
const readLiveNowServer = (): number | null => null;

/**
 * "● 4 Live", the one live badge both homes wear: the Realtime card's title
 * and the page's "Overview" heading, sized per home through `className`.
 * Green with a pulsing dot while anyone is actually on the site; at zero the
 * dot holds still and everything goes grey, because a green pulse over a
 * zero would be a light saying the opposite of its number.
 *
 * text-sm matches the card title, so equal line boxes under items-center put
 * badge and title on one baseline; the heading passes text-base down and
 * aligns through its own items-baseline group instead.
 */
function LiveBadge({
  count,
  className,
}: {
  count: number;
  className?: string;
}) {
  const someone = count > 0;
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1.5 whitespace-nowrap text-sm tabular-nums",
        someone ? "text-success-foreground/80" : "text-muted-foreground",
        className
      )}
    >
      <span className="relative flex size-2 self-center">
        {someone ? (
          <motion.span
            animate={{ opacity: [0.6, 0, 0.6], scale: [1, 2.2, 1] }}
            aria-hidden="true"
            className="absolute inset-0 rounded-full bg-success"
            transition={{
              duration: 2,
              repeat: Number.POSITIVE_INFINITY,
              ease: "easeOut",
            }}
          />
        ) : null}
        <span
          className={cn(
            "relative size-2 rounded-full",
            someone ? "bg-success" : "bg-muted-foreground"
          )}
        />
      </span>
      <span
        className={cn(
          "font-medium",
          someone ? "text-success-foreground" : "text-foreground/80"
        )}
      >
        {count.toLocaleString("en-US")}
      </span>{" "}
      Live
    </span>
  );
}

/** The same badge beside the page's "Overview" heading; nothing until a
 *  snapshot arrives. */
export function OverviewLiveBadge() {
  const count = React.useSyncExternalStore(
    subscribeLiveNow,
    readLiveNow,
    readLiveNowServer
  );
  if (count === null) return null;
  return <LiveBadge className="text-base" count={count} />;
}

/**
 * The overview screen's realtime card: the five people most recently seen on
 * the site, newest first, straight from the private snapshot.
 *
 * It listed the busiest paths until 2026-08-26, which the overview already
 * answers twice over: Top pages ranks them for the whole range, and a live
 * copy of the same ranking differs from it only in being noisier. Presence is
 * the one thing this card can say that no other card on the screen can, so it
 * says that. The rows are `snapshot.present`, the same list the Realtime board
 * calls Online, with the same anonymous face and name (ADR-0035, D-102): a
 * hash you can recognize for a day and never a person.
 *
 * Five, not fifty. The panel holds five rows and the header's "See all" opens
 * the board, which carries the rest along with the journeys, the referrers and
 * the earlier visitors this card deliberately has no room for.
 */
export function RealtimeCard() {
  const params = useParams<{ site: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";
  const { status, snapshot } = useRealtime(slug);
  const setHeaderChip = useSquircleCardHeaderChip();

  // The count rides beside the card's TITLE ("Realtime · ● 4 Live"),
  // through the shell's header slot: it is a fact about the whole card, not
  // the first row of its list. Keyed on the number so a snapshot tick with
  // the same count never re-registers.
  //
  // An unhealthy feed takes that same slot, and takes it from the count
  // (2026-08-26): "Reconnecting" or "Access ended" is a caveat about every
  // number in the card, so it belongs where the card is named rather than in
  // a strip over the rows, and a live count printed beside a stream that is
  // not live is the one thing the header must never say.
  const liveCount = snapshot === null ? null : snapshot.active_visitors;
  React.useEffect(() => {
    if (setHeaderChip === null) return;
    if (status !== "live") {
      setHeaderChip(<RealtimeStatusChip status={status} />);
      return () => setHeaderChip(null);
    }
    if (liveCount === null) return;
    setHeaderChip(<LiveBadge count={liveCount} />);
    return () => setHeaderChip(null);
  }, [setHeaderChip, liveCount, status]);

  // The same number, for the "Overview" heading (see the store above). The
  // card is the screen's one realtime subscriber, so it is also the one
  // publisher; unmounting takes the heading's badge with it.
  React.useEffect(() => {
    publishLiveNow(liveCount);
    return () => publishLiveNow(null);
  }, [liveCount]);

  /**
   * The five most recently seen, newest first.
   *
   * `present` arrives in no order this card can rely on, and "who is here"
   * without an order is a list that reshuffles under the reader on every
   * snapshot. Sorting by `last_seen_at` gives it the one order that also
   * makes the truncation honest: the five it keeps are the five who just
   * moved, and the header's "See all" holds the rest.
   */
  const nowSeconds = useClockBucket() * 10;
  const present = snapshot?.present;
  const latest = React.useMemo(
    () =>
      [...(present ?? [])]
        .sort((a, b) => Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at))
        .slice(0, 5),
    [present]
  );

  if (snapshot === null) {
    // No data yet: connecting, first reconnect, or access already lost. The
    // state itself is named in the header now, so what is left here is the
    // sentence that explains it, and while connecting there is none to give.
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <RealtimeStatusNote status={status} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Nothing above the rows any more, in either direction: the count and
          the caveat both live in the header, and a strip here only ever
          pushed the list down by a row. */}
      {latest.length === 0 ? (
        <p className="flex flex-1 items-center justify-center px-6 pb-4 text-center text-sm leading-6 text-muted-foreground">
          No one is browsing right now.
        </p>
      ) : (
        /* `min-h-0 flex-1` on a wrapper rather than on the scroller itself:
           `SquircleCardScroll` is `h-full`, which every other card resolves
           against the panel because it is the panel's only child. Here a
           status chip can sit above it, and a full-height scroller beside a
           sibling is taller than the room left, so the panel clipped the
           overflow instead of the viewport scrolling it. The list still
           moved under the reader, with no fade at either edge to say so,
           which is what set this card apart from its neighbours. */
        <div className="min-h-0 flex-1">
          <SquircleCardScroll>
            <HoverList>
              {latest.map((visitor) => (
                <HoverRow key={visitor.visitor}>
                  <div className="flex items-center gap-2.5 px-5 py-1.5">
                    <UserAvatar seed={visitor.visitor} size={20} />
                    <span className="shrink-0 text-sm font-medium">
                      {anonName(visitor.visitor)}
                    </span>
                    {/* Mono, because it is a path: the same treatment the
                        Realtime board and the revenue card give one. */}
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                      {visitor.path ?? ""}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {timeAgo(secondsSince(visitor.last_seen_at, nowSeconds))}
                    </span>
                  </div>
                </HoverRow>
              ))}
            </HoverList>
          </SquircleCardScroll>
        </div>
      )}
    </div>
  );
}
