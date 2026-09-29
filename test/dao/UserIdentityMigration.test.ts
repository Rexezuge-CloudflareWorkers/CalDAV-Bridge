import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, splitSql } from '../helpers/migrations';

const LAST_PRE_IDENTITY_MIGRATION = '0003_add_calendar_object_sync_state.sql';
const IDENTITY_MIGRATION = '0004_decouple_user_identity.sql';

const ALICE = 'Alice@Example.com';
const BOB = 'bob@example.com';

/**
 * Every table reachable from `users`. `connected_applications` cascades into all
 * of them, so losing a user silently empties the whole graph -- which is exactly
 * the failure this migration must not cause.
 */
const GUARDED_TABLES = [
  'users',
  'connected_applications',
  'caldav_credentials',
  'oauth2_authorization_sessions',
  'calendar_object_mappings',
  'oauth2_access_token_refresh_status',
] as const;

function openLegacyDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  // D1 enforces foreign keys through the Worker binding, so the test does too:
  // a migration that relies on FKs being off would pass here otherwise.
  database.exec('PRAGMA foreign_keys = ON');
  applyMigrations(database, { to: LAST_PRE_IDENTITY_MIGRATION });
  seedLegacyGraph(database);
  return database;
}

/** One row in every table reachable from `users`. */
function seedLegacyGraph(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO users (email, created_at, updated_at) VALUES ('${ALICE}', 100, 200), ('${BOB}', 101, 201);

    INSERT INTO connected_applications
      (application_id, user_email, provider_email, display_name, provider_id, connection_method, encrypted_credentials, credentials_iv, status, last_error, created_at, updated_at)
    VALUES
      ('app-1', '${ALICE}', null, 'Alice Google', 'google-calendar', 'oauth2', 'enc', 'iv', 'draft', null, 1, 1),
      ('app-2', '${BOB}', null, 'Bob Outlook', 'microsoft-outlook-calendar', 'oauth2', 'enc', 'iv', 'draft', null, 1, 1);

    INSERT INTO caldav_credentials
      (credential_id, application_id, username, password_hash, name, password_prefix, password_last_four, created_at, expires_at)
    VALUES
      ('cred-1', 'app-1', 'alpaca4821', 'hash-1', 'Phone', 'cb_ab', '1234', 1, 9999999999),
      ('cred-2', 'app-2', 'bear7391', 'hash-2', 'Laptop', 'cd_ef', '5678', 1, 9999999999);

    INSERT INTO oauth2_authorization_sessions
      (session_id, application_id, state_hash, code_verifier, redirect_uri, created_at, expires_at)
    VALUES ('session-1', 'app-1', 'state-1', 'verifier', 'https://bridge.example.test/cb', 1, 9999999999);

    INSERT INTO calendar_object_mappings
      (object_id, application_id, calendar_id, href, provider_event_id, uid, etag, created_at, updated_at)
    VALUES ('object-1', 'app-1', 'primary', 'event.ics', 'provider-event-1', 'uid-1', 'etag', 1, 1);

    INSERT INTO oauth2_access_token_refresh_status (application_id, refreshed_at, expires_at)
    VALUES ('app-1', 1, 9999999999);
  `);
}

function countRows(database: DatabaseSync): Record<string, number> {
  // `node:sqlite` types a bare `COUNT(*)` column as the union of every type it
  // can return, since the column's type is not inferable from the query.
  const counts: Record<string, number> = {};
  for (const table of GUARDED_TABLES) {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number } | undefined;
    counts[table] = row?.count ?? 0;
  }
  return counts;
}

function foreignKeyViolations(database: DatabaseSync): unknown[] {
  return database.prepare('PRAGMA foreign_key_check').all();
}

function foreignKeyTargets(database: DatabaseSync, table: string): string[] {
  return database
    .prepare(`PRAGMA foreign_key_list(${table})`)
    .all()
    .map((row: Record<string, unknown>) => `${String(row['from'])} -> ${String(row['table'])}.${String(row['to'])}`);
}

describe('user identity migration', () => {
  let before: Record<string, number>;
  let after: Record<string, number>;
  let database: DatabaseSync;

  beforeAll(() => {
    database = openLegacyDatabase();
    before = countRows(database);

    const legacy = database.prepare('SELECT * FROM users WHERE email = ?').get(ALICE) as Record<string, unknown>;
    // Proves the seed really is pre-identity, so a passing assertion cannot be
    // an artifact of an already-migrated database.
    expect(legacy['user_id']).toBeUndefined();
    expect(legacy['current_email']).toBeUndefined();

    applyMigrations(database, { from: IDENTITY_MIGRATION });
    after = countRows(database);
  });

  it('loses no rows in any table reachable from users', () => {
    expect(after).toEqual(before);
    expect(after['users']).toBe(2);
    expect(after['connected_applications']).toBe(2);
    expect(after['caldav_credentials']).toBe(2);
  });

  it('leaves no dangling foreign keys', () => {
    expect(foreignKeyViolations(database)).toEqual([]);
  });

  it('gives every account a stable v4 user id', () => {
    const rows = database.prepare('SELECT user_id FROM users').all() as Array<{ user_id: string }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.user_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const ids = new Set(rows.map((row) => row.user_id));
    expect(ids.size).toBe(2);
  });

  it('lowercases the login address so a mixed-case anchor yields one identity', () => {
    const alice = database.prepare('SELECT email, current_email FROM users WHERE email = ?').get(ALICE) as Record<string, string>;
    expect(alice['email']).toBe(ALICE);
    expect(alice['current_email']).toBe('alice@example.com');

    const registry = database.prepare('SELECT user_id, is_verified FROM user_emails WHERE email = ?').get('alice@example.com');
    expect(registry).toBeTruthy();
    expect(registry?.['is_verified']).toBe(1);

    // The anchor is frozen and the registry resolves to exactly one account, so
    // the legacy mixed-case row cannot produce a second login identity.
    expect(database.prepare('SELECT COUNT(*) AS count FROM users WHERE current_email = ?').get('alice@example.com')?.count).toBe(1);
  });

  it('keeps email as the primary key so the existing foreign key still resolves', () => {
    const ddl = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()?.sql as string;
    expect(ddl).toContain('email TEXT PRIMARY KEY');

    // The legacy FK must still point at users.email, with the new one alongside
    // it -- dropping or repointing either would have required a table rebuild.
    expect(foreignKeyTargets(database, 'connected_applications')).toEqual(['user_email -> users.email', 'user_id -> users.user_id']);
    expect(foreignKeyTargets(database, 'user_emails')).toEqual(['user_id -> users.user_id']);
  });

  it('resolves every existing application to an account by user id', () => {
    const rows = database
      .prepare('SELECT application_id, user_email, user_id FROM connected_applications ORDER BY application_id')
      .all() as Array<{ application_id: string; user_email: string; user_id: string }>;
    const userIdOf = (email: string): string | null =>
      (database.prepare('SELECT user_id FROM users WHERE email = ?').get(email) as { user_id: string } | undefined)?.user_id ?? null;

    expect(rows.map((row) => [row.application_id, row.user_id])).toEqual([
      ['app-1', userIdOf(ALICE)],
      ['app-2', userIdOf(BOB)],
    ]);
    expect(rows.every((row) => row.user_id !== null)).toBe(true);
    // The anchor copy is preserved verbatim, so the legacy FK value is unchanged.
    expect(rows.map((row) => row.user_email)).toEqual([ALICE, BOB]);
  });

  it('leaves the CalDAV and OAuth2 graph attached to the same applications', () => {
    const row = database
      .prepare(
        `SELECT ca.application_id, ca.user_id,
                (SELECT COUNT(*) FROM caldav_credentials c WHERE c.application_id = ca.application_id) AS credentials,
                (SELECT COUNT(*) FROM calendar_object_mappings m WHERE m.application_id = ca.application_id) AS mappings,
                (SELECT COUNT(*) FROM oauth2_authorization_sessions s WHERE s.application_id = ca.application_id) AS sessions,
                (SELECT COUNT(*) FROM oauth2_access_token_refresh_status t WHERE t.application_id = ca.application_id) AS refresh
         FROM connected_applications ca WHERE ca.application_id = 'app-1'`,
      )
      .get() as Record<string, unknown>;

    expect(row['credentials']).toBe(1);
    expect(row['mappings']).toBe(1);
    expect(row['sessions']).toBe(1);
    expect(row['refresh']).toBe(1);
    expect(row['user_id']).toBe(database.prepare('SELECT user_id FROM users WHERE email = ?').get(ALICE)?.['user_id']);
  });
});

describe('user identity migration guards', () => {
  it('aborts without losing rows when two anchors differ only by case', () => {
    const database = openLegacyDatabase();
    // `users.email` is a case-sensitive primary key today, so a differently-cased
    // anchor for the same person is representable -- and is exactly what the
    // lowercased `current_email` backfill cannot accommodate.
    database.exec(`
      INSERT INTO users (email, created_at, updated_at) VALUES ('alice@example.com', 102, 202);
      INSERT INTO connected_applications
        (application_id, user_email, provider_email, display_name, provider_id, connection_method, encrypted_credentials, credentials_iv, status, last_error, created_at, updated_at)
      VALUES ('app-3', 'alice@example.com', null, 'Alice Second', 'google-calendar', 'oauth2', 'enc', 'iv', 'draft', null, 1, 1);
    `);
    const before = countRows(database);

    expect(() => applyMigrations(database, { from: IDENTITY_MIGRATION })).toThrow(/current_email/i);

    // Nothing was applied: the file is transactional, so an operator can resolve
    // the duplicate and re-run without first repairing half a schema.
    expect(countRows(database)).toEqual(before);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_users_user_id'").get()).toBeUndefined();
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'user_emails'").get()).toBeUndefined();
    expect(foreignKeyViolations(database)).toEqual([]);
  });

  it('guards every backfill so re-running them changes nothing', () => {
    const database = openLegacyDatabase();
    applyMigrations(database, { from: IDENTITY_MIGRATION });
    const afterFirst = countRows(database);
    const idsBefore = database.prepare('SELECT user_id, current_email FROM users ORDER BY email').all();
    const registryBefore = database.prepare('SELECT email, user_id, is_verified FROM user_emails ORDER BY email').all();
    const appsBefore = database.prepare('SELECT application_id, user_id FROM connected_applications ORDER BY application_id').all();

    // `ALTER TABLE ... ADD COLUMN` is not re-runnable in SQLite, and D1 records
    // applied files so it never has to be. What must be idempotent is the data
    // backfill: re-applying it cannot mint new ids or unlink applications.
    database.exec('BEGIN');
    for (const statement of splitSql(IDEMPOTENT_BACKFILL)) database.exec(statement);
    database.exec('COMMIT');

    expect(countRows(database)).toEqual(afterFirst);
    expect(database.prepare('SELECT user_id, current_email FROM users ORDER BY email').all()).toEqual(idsBefore);
    expect(database.prepare('SELECT email, user_id, is_verified FROM user_emails ORDER BY email').all()).toEqual(registryBefore);
    expect(database.prepare('SELECT application_id, user_id FROM connected_applications ORDER BY application_id').all()).toEqual(
      appsBefore,
    );
  });
});

/** The guarded half of `0004`, mirrored from the migration. */
const IDEMPOTENT_BACKFILL = `
  UPDATE users
  SET user_id = lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(randomblob(4)) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )
  WHERE user_id IS NULL;

  UPDATE users SET current_email = lower(email) WHERE current_email IS NULL AND email IS NOT NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_current_email ON users(current_email);
  CREATE TABLE IF NOT EXISTS user_emails (
    email TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    is_verified INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_user_emails_user_id ON user_emails(user_id);

  INSERT OR IGNORE INTO user_emails (email, user_id, is_verified, created_at)
  SELECT lower(email), user_id, 1, created_at FROM users WHERE email IS NOT NULL;

  UPDATE connected_applications
  SET user_id = (
    SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(connected_applications.user_email) LIMIT 1
  );

  CREATE INDEX IF NOT EXISTS idx_connected_applications_user_id ON connected_applications(user_id);
`;
