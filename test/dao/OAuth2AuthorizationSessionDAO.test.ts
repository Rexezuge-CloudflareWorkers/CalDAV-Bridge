import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { OAuth2AuthorizationSessionDAO } from '@caldav-bridge/backend-data/dao';
import { TimestampUtil } from '@caldav-bridge/shared/utils';
import { asD1Queryable } from '../helpers/d1';
import { applyMigrations } from '../helpers/migrations';

const APP = 'app-1';
const STATE_HASH = 'a'.repeat(64);
const VERIFIER = 'pkce-verifier-value';
const REDIRECT_URI = 'https://bridge.example.test/api/oauth2/callback/app-1';

function openDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  applyMigrations(database);
  database
    .prepare('INSERT INTO users (email, created_at, updated_at, user_id, current_email) VALUES (?, ?, ?, ?, ?)')
    .run('owner@example.com', 100, 100, 'user-1', 'owner@example.com');
  database
    .prepare(
      `INSERT INTO connected_applications
        (application_id, user_email, user_id, display_name, provider_id, connection_method,
         encrypted_credentials, credentials_iv, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'google-calendar', 'oauth2', 'enc', 'iv', 'draft', 100, 100)`,
    )
    .run(APP, 'owner@example.com', 'user-1', 'Application');
  return database;
}

async function createSession(
  dao: OAuth2AuthorizationSessionDAO,
  overrides: Partial<{ stateHash: string; expiresAt: number }> = {},
): Promise<void> {
  await dao.create(
    APP,
    overrides.stateHash ?? STATE_HASH,
    VERIFIER,
    REDIRECT_URI,
    overrides.expiresAt ?? TimestampUtil.getCurrentUnixTimestampInSeconds() + 900,
  );
}

describe('OAuth2AuthorizationSessionDAO', () => {
  let database: DatabaseSync;
  let dao: OAuth2AuthorizationSessionDAO;

  beforeEach(async () => {
    database = openDatabase();
    dao = new OAuth2AuthorizationSessionDAO(asD1Queryable(database));
    await createSession(dao);
  });

  /**
   * A session is the only thing standing between a leaked `code` and someone
   * else's calendar, so each of these guards is a security property rather than
   * a detail of the query.
   */
  it('returns a session that is unconsumed and unexpired', async () => {
    const session = await dao.getActive(APP, STATE_HASH);

    expect(session).toMatchObject({ applicationId: APP, stateHash: STATE_HASH, codeVerifier: VERIFIER, redirectUri: REDIRECT_URI });
    expect(session?.consumedAt).toBeNull();
  });

  it('refuses a session whose state was already consumed', async () => {
    const session = await dao.getActive(APP, STATE_HASH);
    await dao.consume(session?.sessionId as string);

    // Replaying a consumed `state` is the replay this guard exists to stop.
    await expect(dao.getActive(APP, STATE_HASH)).resolves.toBeUndefined();
  });

  it('refuses an expired session', async () => {
    const second = new OAuth2AuthorizationSessionDAO(asD1Queryable(database));
    await createSession(second, { stateHash: 'b'.repeat(64), expiresAt: TimestampUtil.getCurrentUnixTimestampInSeconds() - 1 });

    await expect(second.getActive(APP, 'b'.repeat(64))).resolves.toBeUndefined();
  });

  it('refuses a state issued for another application', async () => {
    // A valid state from one application must not authorize a callback for
    // another, even though the state itself is unguessable.
    await expect(dao.getActive('some-other-app', STATE_HASH)).resolves.toBeUndefined();
  });

  it('refuses an unknown state', async () => {
    await expect(dao.getActive(APP, 'f'.repeat(64))).resolves.toBeUndefined();
  });

  it('records when a session was consumed', async () => {
    const before = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const session = await dao.getActive(APP, STATE_HASH);

    await dao.consume(session?.sessionId as string);

    const row = database
      .prepare('SELECT consumed_at FROM oauth2_authorization_sessions WHERE session_id = ?')
      .get(session?.sessionId as string) as { consumed_at: number | null };
    expect(row.consumed_at).toBeGreaterThanOrEqual(before);
  });

  it('reaps an expired session while leaving a live one alone', async () => {
    const reaper = new OAuth2AuthorizationSessionDAO(asD1Queryable(database));
    await createSession(reaper, { stateHash: 'c'.repeat(64), expiresAt: TimestampUtil.getCurrentUnixTimestampInSeconds() - 10 });

    const deleted = await reaper.deleteTerminalBefore(TimestampUtil.getCurrentUnixTimestampInSeconds(), 10);

    expect(deleted).toBe(1);
    // An authorization in progress must not be reaped out from under the user
    // completing it.
    await expect(reaper.getActive(APP, STATE_HASH)).resolves.toBeDefined();
  });

  /**
   * A consumed session is reaped on a later run, not the same one. `consumed_at`
   * has second resolution, so a session consumed in the same second as the reaper
   * is not yet older than the cutoff. That is the safe direction: a session
   * outliving its reaping costs a row, while one reaped early would break a
   * callback still in flight.
   */
  it('reaps a consumed session once it is older than the cutoff', async () => {
    const reaper = new OAuth2AuthorizationSessionDAO(asD1Queryable(database));
    const active = await reaper.getActive(APP, STATE_HASH);
    await reaper.consume(active?.sessionId as string);
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();

    expect(await reaper.deleteTerminalBefore(now, 10)).toBe(0);
    expect(await reaper.deleteTerminalBefore(now + 1, 10)).toBe(1);
  });

  it('keeps a session that is still live when reaping', async () => {
    const reaper = new OAuth2AuthorizationSessionDAO(asD1Queryable(database));
    await createSession(reaper, { stateHash: 'd'.repeat(64) });

    const deleted = await reaper.deleteTerminalBefore(TimestampUtil.getCurrentUnixTimestampInSeconds(), 10);

    expect(deleted).toBe(0);
    await expect(reaper.getActive(APP, 'd'.repeat(64))).resolves.toBeDefined();
  });

  it('reaps only up to the limit, so a large table drains over several runs', async () => {
    const reaper = new OAuth2AuthorizationSessionDAO(asD1Queryable(database));
    for (let index = 0; index < 5; index += 1) {
      await createSession(reaper, {
        stateHash: `e${index}`.padEnd(64, '0'),
        expiresAt: TimestampUtil.getCurrentUnixTimestampInSeconds() - 10,
      });
    }

    expect(await reaper.deleteTerminalBefore(TimestampUtil.getCurrentUnixTimestampInSeconds(), 2)).toBe(2);
    expect(await reaper.deleteTerminalBefore(TimestampUtil.getCurrentUnixTimestampInSeconds(), 2)).toBe(2);
    expect(await reaper.deleteTerminalBefore(TimestampUtil.getCurrentUnixTimestampInSeconds(), 2)).toBe(1);
  });

  it('removes a session with the application it belongs to', async () => {
    // The foreign key is `ON DELETE CASCADE`, so the session goes with the
    // application without the reaper running at all.
    database.prepare('DELETE FROM connected_applications WHERE application_id = ?').run(APP);

    const remaining = database.prepare('SELECT COUNT(*) AS count FROM oauth2_authorization_sessions').get() as { count: number };
    expect(remaining.count).toBe(0);
  });

  /**
   * `deleteOrphaned` is a backstop for a row the cascade could not remove -- a
   * session written while the foreign key was unenforced, or one whose
   * application row was already gone. It is exercised here by writing the orphan
   * directly, since the cascade makes it unreachable through the DAO otherwise.
   */
  it('removes a session whose application row is already gone', async () => {
    const orphaned = new OAuth2AuthorizationSessionDAO(asD1Queryable(database));
    database.exec('PRAGMA foreign_keys = OFF');
    await orphaned.create(
      'deleted-application',
      'z'.repeat(64),
      VERIFIER,
      REDIRECT_URI,
      TimestampUtil.getCurrentUnixTimestampInSeconds() + 900,
    );
    database.exec('PRAGMA foreign_keys = ON');

    expect(await orphaned.deleteOrphaned(10)).toBe(1);
  });
});
