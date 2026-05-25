ALTER TABLE calendar_object_mappings ADD COLUMN deleted_at INTEGER;
ALTER TABLE calendar_object_mappings ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_calendar_object_mappings_sync ON calendar_object_mappings(application_id, calendar_id, sync_version);
