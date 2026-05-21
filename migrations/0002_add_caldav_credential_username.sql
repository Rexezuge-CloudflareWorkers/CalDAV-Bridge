DELETE FROM caldav_credentials;

ALTER TABLE caldav_credentials ADD COLUMN username TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX idx_caldav_credentials_username ON caldav_credentials(username);
