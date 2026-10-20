# Recovering a session-finalizer overlap stall

A capped raw-event window used to advance only to a time that no session
crossed. Independent visitors can form a continuous overlap chain, so this
site-wide gap need never exist. The finalizer can report successful runs while
repeatedly reading the same 200,000-row prefix and never reaching later events.

The repaired finalizer advances to the earliest provisional session. A closed
session that crosses this boundary keeps its exact raw-event IDs in
`session_facts_versions.event_ids`. The next pass excludes those IDs before
sessionizing the remaining events. It does not approximate membership from a
visitor ID, client hint or fixed lookback window, which can change the result
around identity stitching, midnight rotation or the maximum session length.

## Review and validation

Migration `0025_session_event_membership.sql` is additive:

```sql
ALTER TABLE session_facts_versions
  ADD COLUMN IF NOT EXISTS event_ids Array(String);
```

The column is included in the fact fingerprint, latest-version projection,
normal writes and retraction tombstones. A legacy in-window fact with empty
membership is re-versioned from raw events before the watermark advances past
it. A pre-existing closed fact crossing the current watermark with empty
membership causes `session_finalized_tail_membership_missing` and leaves the
watermark unchanged. Empty membership is never treated as proof of no events.

Unit coverage includes a failing-before-fix overlap regression, repeated capped
passes with no duplicated events or sessions, an event exactly on the boundary,
maximum-length splitting, midnight rotation, identify stitching, legacy fact
bootstrap, retractions and unchanged reruns. The ClickHouse migration suite
also checks real tail SQL, latest-version tombstone handling and final rollups.

## Rollout order

1. Take the normal coordinated ClickHouse and Postgres backup before changing
   schema or worker behavior. Record the existing image digest and watermark.
2. Build and test the exact reviewed commit. This fork's worker-image workflow
   is manual only. Dispatching it publishes an image and is a separate operator
   action, not an effect of opening or updating the pull request.
   GitHub requires this workflow to exist on the default branch before it can
   be dispatched. Register it through the separate workflow-only pull request
   first, then select the reviewed repair branch as the dispatch ref.
3. Run the normal ClickHouse migration runner with the reviewed migrations.
   Dry-run first, verify only expected pending files, then apply. The migration
   account performs DDL. No worker credential or grant changes are required.
4. Verify `event_ids` is `Array(String)`, then deploy the matching worker image.
   The old worker tolerates the extra column while rollout is in progress.
5. Observe several finalizer passes. The per-site `from_ms` and `to_ms` must
   move forward through the backlog, the read API's `finalized_through` must
   advance, and historical session facts/rollups must appear. A worker restart
   or successful pass counter alone proves none of these.
6. Allow the existing five-minute job to drain retained raw events, then run the
   dashboard data pull again. Do not manually push the watermark forward, use
   zeros for missing sessions, or delete raw data to make the backlog disappear.

No production migration, image publication, image replacement or watermark
mutation is performed by the code change or this document.

## Rollback and remaining bounds

There is no down migration. Keep the added column. Before the new worker has
advanced a watermark, reverting its image is compatible with the expanded
schema. **After it advances, an old worker is not a safe image-only rollback:**
the new watermark may intentionally cross a closed session, and an old worker
cannot exclude that session's tail. Follow the repository's coordinated backup
restore procedure instead, with its stated loss of events accepted since the
backup. Do not attempt a blind watermark reset alongside live fact tables.

The raw-event cap stays at 200,000. This change fixes chains of already-closed
overlapping sessions. If one genuinely provisional session itself spans an
entire capped prefix, that prefix still cannot be finalized safely without
reading more of that session. Such a pass now logs
`session_finalizer_watermark_stalled`. Supporting that separate density case
requires a bounded per-session continuation design. It is not solved by
silently increasing memory or pretending the partial session is closed.

The closed-tail query reads the site's stored fact versions before the current
watermark and filters latest versions in ClickHouse. Its cost grows with
retained fact history. The exact event arrays also add storage proportional to
session event membership. Monitor query time, worker memory and backlog lag
during recovery before changing the cap or cadence.
