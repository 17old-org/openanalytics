-- Exact raw-event membership lets the finalizer advance past CLOSED sessions
-- that overlap another visitor's still-provisional session. A site-wide gap is
-- not guaranteed: independent visitors can form an unbounded overlap chain and
-- pin the capped recompute to the same prefix forever.
--
-- Expand first. Apply this migration before starting the new worker. Old
-- workers ignore the added column. Existing rows read [] until recomputed. The
-- new finalizer re-versions those rows before advancing past them, and refuses
-- a pre-existing closed tail with unknown membership rather than duplicating it.
-- No raw-event mutation, facts deletion or watermark reset is required.
ALTER TABLE session_facts_versions
  ADD COLUMN IF NOT EXISTS event_ids Array(String);
