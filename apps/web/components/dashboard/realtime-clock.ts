"use client";

import * as React from "react";

/**
 * The realtime screens' shared clock, and the one vocabulary they age things
 * in.
 *
 * The clock is an external store in 10-second buckets: reading time during
 * render is impure (react-hooks/purity), so components subscribe here instead
 * and every age on screen recomputes on each tick for free. The bucket, rather
 * than the millisecond, is what keeps `getSnapshot` stable between ticks,
 * which `useSyncExternalStore` requires.
 *
 * It lives beside `anon-identity.ts` for the same reason that file does: the
 * Realtime board and the overview card show the same visitors, and a person
 * who is "now" on one screen and "12s ago" on the other reads as two different
 * facts. One clock, one phrasing, both screens.
 */

const subscribeClock = (onChange: () => void) => {
  const timer = setInterval(onChange, 10_000);
  return () => clearInterval(timer);
};

const readClockBucket = () => Math.floor(Date.now() / 10_000);
const readClockBucketServer = () => 0;

/** The current 10-second bucket. Multiply by 10 for seconds, 10_000 for ms. */
export function useClockBucket(): number {
  return React.useSyncExternalStore(
    subscribeClock,
    readClockBucket,
    readClockBucketServer
  );
}

/**
 * How long ago, in the shortest phrase that is still true. Under fifteen
 * seconds it says "now", because a live feed counting single seconds asks a
 * reader to watch a number instead of the page.
 */
export function timeAgo(secondsAgo: number): string {
  if (secondsAgo < 15) return "now";
  if (secondsAgo < 60) return `${secondsAgo}s ago`;
  if (secondsAgo < 3600) return `${Math.floor(secondsAgo / 60)}m ago`;
  return `${Math.floor(secondsAgo / 3600)}h ago`;
}

/** Seconds between an ISO instant and the clock's current bucket, never below zero. */
export function secondsSince(iso: string, nowSeconds: number): number {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, nowSeconds - Math.floor(at / 1000));
}
