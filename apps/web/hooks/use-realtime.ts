"use client";

import type { RealtimeSnapshot } from "@openanalytics/contracts";
import { useRouter } from "next/navigation";
import * as React from "react";
import {
  errorCodeOf,
  isUnauthenticated,
  LIVE_API,
  mintRealtimeToken,
  resolveSiteSlugCached,
} from "@/lib/api";
import { MOCK_REALTIME_SNAPSHOT } from "@/lib/mock";
import {
  backoffDelay,
  DEFAULT_RETRY_MS,
  readSseRecords,
  STREAM_URL,
  statusAfterControl,
  toFrame,
  type RealtimeStatus,
} from "@/lib/realtime";

/**
 * The authenticated live-visitors stream for one site
 * (frontend_realtime_contract): mint a ≤60 s token, fetch-stream the SSE
 * endpoint with it, and hand every snapshot to the caller — each one fully
 * supersedes the last, so state is replaced, never accumulated.
 *
 * Reconnects mint a fresh token (the old one has expired by then) and resume
 * with `Last-Event-ID`, backing off around the stream's own `retry:` hint.
 *
 * `access_lost` is terminal for the hook's lifetime, and for that reason it is
 * only reached by a refusal that **survives a fresh token** (2026-08-26).
 * Every path into it used to be believed on the spot, which painted a red
 * "Access ended" over three ordinary things:
 *
 * - A token is good for at most 60 seconds. A backgrounded tab has its timers
 *   throttled and can be frozen outright, so the gap between minting one and
 *   opening the stream with it can outlast it. The `401` that answers is about
 *   the token, not the person.
 * - A `404` is what an edge answers while the realtime service is being
 *   replaced. It means "no route right now", not "not your site".
 * - `access_revoked` is the control frame the server sends when an epoch moves
 *   (a member removed, share settings changed, a deletion started, or the
 *   worker replaying that bump from its outbox). The realtime hub's own
 *   comment states the client's part: "stop, re-mint, and find out why from
 *   the API" is the contract, and over-bumping is called safe precisely
 *   because of it.
 *
 * So each of those costs one more round trip with a new token, and only the
 * second refusal is believed. A `403` still is: the gateway read the token and
 * said this person may not have this site.
 */
export function useRealtime(slug: string): {
  status: RealtimeStatus;
  snapshot: RealtimeSnapshot | null;
} {
  const router = useRouter();
  const [status, setStatus] = React.useState<RealtimeStatus>(
    LIVE_API ? "connecting" : "live"
  );
  const [snapshot, setSnapshot] = React.useState<RealtimeSnapshot | null>(
    LIVE_API ? null : MOCK_REALTIME_SNAPSHOT
  );

  React.useEffect(() => {
    // No site, no stream: callers like the tab bar mount on slug-less pages
    // too, and an empty slug would only loop through resolve failures.
    if (!LIVE_API || slug === "") return;

    const abort = new AbortController();

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        abort.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true }
        );
      });

    const run = async () => {
      let attempt = 0;
      let lastId: string | null = null;
      let retryHintMs = DEFAULT_RETRY_MS;
      /**
       * Whether a refusal is already standing, unanswered by a fresh token.
       * Cleared by any stream that opens, so the allowance is one per healthy
       * connection rather than one per page.
       */
      let refusedOnce = false;

      while (!abort.signal.aborted) {
        try {
          const { site_id } = await resolveSiteSlugCached(slug);
          const { token } = await mintRealtimeToken(site_id);
          const response = await fetch(STREAM_URL, {
            headers: {
              accept: "text/event-stream",
              authorization: `Bearer ${token}`,
              ...(lastId ? { "last-event-id": lastId } : {}),
            },
            signal: abort.signal,
          });

          // 403 is the gateway having read the token and answered about the
          // person. 401 and 404 are answers about the token and the route,
          // which a new token settles, so they are worth exactly one more.
          if (response.status === 403) {
            setStatus("access_lost");
            return;
          }
          if (response.status === 401 || response.status === 404) {
            if (refusedOnce) {
              setStatus("access_lost");
              return;
            }
            refusedOnce = true;
            setStatus("reconnecting");
          } else {
            if (!response.ok || !response.body) {
              throw new Error(`stream answered ${response.status}`);
            }

            attempt = 0;
            refusedOnce = false;
            setStatus("live");

            for await (const record of readSseRecords(
              response.body,
              abort.signal
            )) {
              if (record.retry !== undefined) retryHintMs = record.retry;
              const frame = toFrame(record, "private");
              if (!frame) continue;
              if (frame.type === "retry") continue;
              if (frame.type === "snapshot") {
                if (frame.id) lastId = frame.id;
                setSnapshot(frame.data as RealtimeSnapshot);
                setStatus("live");
                continue;
              }
              const next = statusAfterControl(frame.data);
              if (frame.data.action === "disconnect") {
                // A revocation is a claim about access that a fresh token can
                // check. Believed the second time it is made, answered the
                // first time by reconnecting.
                if (next === "access_lost") {
                  if (refusedOnce) {
                    setStatus("access_lost");
                    return;
                  }
                  refusedOnce = true;
                  setStatus("reconnecting");
                } else {
                  setStatus(next);
                }
                break;
              }
              setStatus(next);
            }
            // Stream ended (network drop or server break), so fall through
            // to the backoff and reconnect.
            if (!abort.signal.aborted && !refusedOnce) {
              setStatus("reconnecting");
            }
          }
        } catch (raised: unknown) {
          if (abort.signal.aborted) return;
          if (isUnauthenticated(raised)) {
            router.replace("/login");
            return;
          }
          const code = errorCodeOf(raised);
          if (
            code === "SITE_NOT_FOUND" ||
            code === "FORBIDDEN" ||
            code === "SITE_SUSPENDED"
          ) {
            setStatus("access_lost");
            return;
          }
          setStatus("reconnecting");
        }

        attempt += 1;
        await sleep(backoffDelay(retryHintMs, attempt));
      }
    };

    void run();
    return () => abort.abort();
  }, [slug, router]);

  return { status, snapshot };
}
