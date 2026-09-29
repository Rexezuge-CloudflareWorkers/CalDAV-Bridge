-- Migration 0002: Add a CalDAV credential username.
--
-- DESTRUCTIVE, and intentionally so. The username column is added NOT NULL, and
-- credentials issued before it existed carry no username to backfill, so there
-- is nothing to migrate. Rather than leave a column no row satisfies -- and a
-- unique index over an empty string that would admit at most one credential --
-- the table is emptied and every holder re-issues a credential.
--
-- One-shot by construction: `wrangler d1 migrations apply` records the files it
-- has run, so this is applied exactly once per database. It should not be
-- re-run by hand against a populated database, which would invalidate every
-- issued CalDAV password a second time.

DELETE FROM caldav_credentials;

ALTER TABLE caldav_credentials ADD COLUMN username TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX idx_caldav_credentials_username ON caldav_credentials(username);
