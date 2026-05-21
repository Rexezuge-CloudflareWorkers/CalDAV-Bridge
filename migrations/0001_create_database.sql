CREATE TABLE users (
    email TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE connected_applications (
    application_id TEXT PRIMARY KEY,
    user_email TEXT NOT NULL,
    provider_email TEXT,
    display_name TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    connection_method TEXT NOT NULL,
    encrypted_credentials TEXT NOT NULL,
    credentials_iv TEXT NOT NULL,
    status TEXT NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE,
    CHECK (provider_id IN ('google-calendar', 'microsoft-outlook-calendar')),
    CHECK (connection_method IN ('oauth2')),
    CHECK (status IN ('draft', 'connected', 'error'))
);

CREATE TABLE caldav_credentials (
    credential_id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    password_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_prefix TEXT NOT NULL,
    password_last_four TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_used_at INTEGER,
    FOREIGN KEY (application_id) REFERENCES connected_applications(application_id) ON DELETE CASCADE
);

CREATE TABLE oauth2_authorization_sessions (
    session_id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    state_hash TEXT NOT NULL UNIQUE,
    code_verifier TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    FOREIGN KEY (application_id) REFERENCES connected_applications(application_id) ON DELETE CASCADE
);

CREATE TABLE calendar_object_mappings (
    object_id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    calendar_id TEXT NOT NULL,
    href TEXT NOT NULL,
    provider_event_id TEXT NOT NULL,
    uid TEXT NOT NULL,
    etag TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (application_id) REFERENCES connected_applications(application_id) ON DELETE CASCADE,
    UNIQUE (application_id, calendar_id, href),
    UNIQUE (application_id, calendar_id, provider_event_id)
);

CREATE TABLE oauth2_access_token_refresh_status (
    application_id TEXT PRIMARY KEY,
    refreshed_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_error TEXT,
    FOREIGN KEY (application_id) REFERENCES connected_applications(application_id) ON DELETE CASCADE
);

CREATE INDEX idx_connected_applications_user_email ON connected_applications(user_email);
CREATE INDEX idx_caldav_credentials_application_id ON caldav_credentials(application_id);
CREATE INDEX idx_caldav_credentials_password_hash ON caldav_credentials(password_hash);
CREATE INDEX idx_caldav_credentials_expires_at ON caldav_credentials(expires_at);
CREATE INDEX idx_oauth2_authorization_sessions_application_id ON oauth2_authorization_sessions(application_id);
CREATE INDEX idx_oauth2_authorization_sessions_expires_at ON oauth2_authorization_sessions(expires_at);
CREATE INDEX idx_calendar_object_mappings_application_calendar ON calendar_object_mappings(application_id, calendar_id);
