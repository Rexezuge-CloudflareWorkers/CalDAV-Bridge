-- Migration 0005: Per-collection monotonic sync counter.
--
-- `calendar_object_mappings.sync_version` was allocated as
-- `MAX(sync_version) + 1` for the whole collection, read and written per
-- event. A full calendar sync upserts every event concurrently, so N events
-- read the same maximum and all wrote the same next value.
--
-- Two consequences, both permanent:
--
--   * A version could be re-issued to a *different* object after a client had
--     already been handed it. That client's next `sync-collection` asks for
--     `sync_version > token`, so the object is skipped and the client never
--     learns it exists. The two sides diverge with no way to recover.
--   * Duplicate versions made the ordering ambiguous, so "everything changed
--     since N" could not be answered reliably at all.
--
-- The counter moves to its own row so it can be bumped once per sync and
-- stamped onto the whole batch, instead of once per row. `DB.batch()` runs
-- the statements as one transaction, so every mapping in a sync shares one
-- version and no two syncs can interleave.
--
-- This is purely additive: a new table, backfilled from the existing maximum
-- per collection so no already-issued token changes meaning. No table is
-- rebuilt and no `DROP TABLE` + `RENAME` appears anywhere in it.
--
-- Rerunnable: the backfill is guarded by `INSERT OR IGNORE` and the table and
-- index use `IF NOT EXISTS`, so re-applying cannot mint a divergent counter.
-- `wrangler d1 migrations apply` records applied files, so it never needs to.

CREATE TABLE IF NOT EXISTS calendar_sync_counters (
  application_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (application_id, calendar_id)
);

-- Seed one counter per collection that already has mappings. Starting at the
-- current maximum keeps every sync token already issued by the previous scheme
-- valid, and keeps `sync_version > token` meaning exactly what it meant before.
INSERT OR IGNORE INTO calendar_sync_counters (application_id, calendar_id, version)
SELECT application_id, calendar_id, COALESCE(MAX(sync_version), 0)
FROM calendar_object_mappings
GROUP BY application_id, calendar_id;

-- The counter is read and written on every sync, keyed by collection.
CREATE INDEX IF NOT EXISTS idx_calendar_sync_counters_collection ON calendar_sync_counters(application_id, calendar_id);
