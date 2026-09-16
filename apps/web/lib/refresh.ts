"use client";

import * as React from "react";

/**
 * The dashboard's refresh pulse: one module-level epoch that every data hook
 * folds into its request identity, so bumping it re-runs every read that is
 * currently mounted, and only those. The overview's refresh button (and its
 * `R` key) is the one publisher today.
 *
 * A module store rather than context, the live-count store's own shape: the
 * button lives in the page header and the readers live in every card, and
 * threading a provider through the layout for one integer would be ceremony.
 * The epoch only ever grows, so a subscriber can never observe it moving
 * backwards; the server snapshot is the starting value, which is also what
 * every client render before the first press reads, so hydration agrees.
 */

let epoch = 0;
const listeners = new Set<() => void>();

/** Every mounted `useApi` / `useApiResource` read re-fetches. */
export function requestRefresh(): void {
  epoch += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = () => epoch;

export function useRefreshEpoch(): number {
  return React.useSyncExternalStore(subscribe, read, read);
}
