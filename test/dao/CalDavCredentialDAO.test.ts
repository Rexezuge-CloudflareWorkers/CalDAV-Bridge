import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { CalDavCredentialDAO } from '@caldav-bridge/backend-data/dao';
import { CalDavCredentialUtil, TimestampUtil } from '@caldav-bridge/shared/utils';
import { asD1Queryable } from '../helpers/d1';
import { applyMigrations } from '../helpers/migrations';

const APP = 'app-1';
const USERNAME = 'otter1234';

/**
 * The password hash is `UNIQUE`, so two credentials cannot share a password. In
 * production each credential gets a freshly generated one; here it is derived
 * from the username, which keeps each fixture's password predictable for the
 * assertions below while still being distinct per credential.
 */
const passwordFor = (username: string): string => `cb_generated-password-for-${username}`;

async function openDatabase(): Promise<{ database: DatabaseSync; dao: CalDavCredentialDAO }> {
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
       VALUES (?, ?, ?, ?, 'google-calendar', 'oauth2', 'enc', 'iv', 'connected', 100, 100)`,
    )
    .run(APP, 'owner@example.com', 'user-1', 'Application');
  return { database, dao: new CalDavCredentialDAO(asD1Queryable(database)) };
}

async function issueCredential(dao: CalDavCredentialDAO, overrides: Partial<{ username: string; expiresAt: number }> = {}) {
  const username = overrides.username ?? USERNAME;
  const password = passwordFor(username);
  return dao.create(
    APP,
    username,
    await CalDavCredentialUtil.hashPassword(password),
    'Laptop',
    CalDavCredentialUtil.getPrefix(password),
    CalDavCredentialUtil.getLastFour(password),
    overrides.expiresAt ?? TimestampUtil.getCurrentUnixTimestampInSeconds() + 86_400,
  );
}

const hashOf = (username: string): Promise<string> => CalDavCredentialUtil.hashPassword(passwordFor(username));

describe('CalDavCredentialDAO', () => {
  let database: DatabaseSync;
  let dao: CalDavCredentialDAO;

  beforeEach(async () => {
    ({ database, dao } = await openDatabase());
  });

  /**
   * This lookup is the whole authentication path for a CalDAV client: the
   * username and the password hash are the only things standing between a guessed
   * password and someone's calendar.
   */
  describe('authentication', () => {
    it('resolves a credential from its username and password', async () => {
      await issueCredential(dao);

      const credential = await dao.getByUsernameAndHash('otter1234', await hashOf(USERNAME), true);

      expect(credential?.username).toBe('otter1234');
    });

    it('refuses a wrong password', async () => {
      await issueCredential(dao);

      const credential = await dao.getByUsernameAndHash(
        'otter1234',
        await CalDavCredentialUtil.hashPassword('definitely-not-the-password'),
        true,
      );

      expect(credential).toBeUndefined();
    });

    it('refuses an unknown username', async () => {
      await issueCredential(dao);

      await expect(dao.getByUsernameAndHash('brute1234', await hashOf(USERNAME), true)).resolves.toBeUndefined();
    });

    it('refuses an expired credential when only active ones are wanted', async () => {
      await issueCredential(dao, { expiresAt: TimestampUtil.getCurrentUnixTimestampInSeconds() - 1 });

      // A CalDAV client cannot present a refresh token, so an expired password is
      // the only signal it has. Accepting it would keep a revoked credential live.
      await expect(dao.getByUsernameAndHash('otter1234', await hashOf(USERNAME), true)).resolves.toBeUndefined();
    });

    it('returns an expired credential when expiry is not being enforced', async () => {
      await issueCredential(dao, { expiresAt: TimestampUtil.getCurrentUnixTimestampInSeconds() - 1 });

      await expect(dao.getByUsernameAndHash('otter1234', await hashOf(USERNAME), false)).resolves.toBeDefined();
    });

    it('never returns the password hash in the metadata', async () => {
      await issueCredential(dao);

      const credential = await dao.getByUsernameAndHash('otter1234', await hashOf(USERNAME), true);

      // The metadata feeds the UI, which needs to show a username and a hint --
      // never the hash it is compared against.
      expect(credential).not.toHaveProperty('passwordHash');
      expect(credential).not.toHaveProperty('password_hash');
    });
  });

  it('reads a credential back by its id', async () => {
    const created = await issueCredential(dao);

    await expect(dao.getById(created.credentialId)).resolves.toMatchObject({ credentialId: created.credentialId });
    await expect(dao.getById('no-such-credential')).resolves.toBeUndefined();
  });

  it('lists an application credentials newest first', async () => {
    const first = await issueCredential(dao, { username: 'otter0001' });
    const second = await issueCredential(dao, { username: 'otter0002' });
    // Both were created within the same second, so the order is pinned by
    // rewriting one timestamp rather than relying on the clock.
    database.prepare('UPDATE caldav_credentials SET created_at = 100 WHERE credential_id = ?').run(first.credentialId);
    database.prepare('UPDATE caldav_credentials SET created_at = 200 WHERE credential_id = ?').run(second.credentialId);

    const listed = await dao.listByApplication(APP);

    expect(listed.map((credential) => credential.username)).toEqual(['otter0002', 'otter0001']);
  });

  it('refuses a duplicate username', async () => {
    await issueCredential(dao);

    // The unique index is the only thing preventing two credentials sharing a
    // username, which would make the first one unreachable.
    await expect(issueCredential(dao)).rejects.toThrow();
  });

  it('reports whether a username is taken, without reading the row', async () => {
    await issueCredential(dao);

    await expect(dao.usernameExists('otter1234')).resolves.toBe(true);
    await expect(dao.usernameExists('free1234')).resolves.toBe(false);
  });

  it('counts an application credentials', async () => {
    await issueCredential(dao, { username: 'otter0001' });
    await issueCredential(dao, { username: 'otter0002' });

    await expect(dao.countByApplication(APP)).resolves.toBe(2);
    await expect(dao.countByApplication('no-such-app')).resolves.toBe(0);
  });

  it('records the last use, which is the only usage signal available', async () => {
    const created = await issueCredential(dao);

    await dao.updateLastUsed(created.credentialId);

    const credential = await dao.getById(created.credentialId);
    expect(credential?.lastUsedAt).toBeGreaterThan(0);
  });

  /**
   * A credential is a live password for a real calendar, so deletion has to be
   * scoped to the application that owns it. Scoping only by credential id would
   * let one application delete another's.
   */
  it('deletes only a credential belonging to the application', async () => {
    const created = await issueCredential(dao);

    await dao.deleteForApplication(created.credentialId, 'some-other-app');
    await expect(dao.getById(created.credentialId)).resolves.toBeDefined();

    await dao.deleteForApplication(created.credentialId, APP);
    await expect(dao.getById(created.credentialId)).resolves.toBeUndefined();
  });

  it('reaps credentials past their expiry, bounded by the limit', async () => {
    await issueCredential(dao, { username: 'expired1', expiresAt: TimestampUtil.getCurrentUnixTimestampInSeconds() - 10 });
    await issueCredential(dao, { username: 'expired2', expiresAt: TimestampUtil.getCurrentUnixTimestampInSeconds() - 10 });
    await issueCredential(dao, { username: 'live0001', expiresAt: TimestampUtil.getCurrentUnixTimestampInSeconds() + 86_400 });

    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    expect(await dao.deleteExpiredBefore(now, 1)).toBe(1);
    expect(await dao.deleteExpiredBefore(now, 10)).toBe(1);
    // A credential still in date is a working password and must survive.
    expect(await dao.countByApplication(APP)).toBe(1);
  });

  it('reaps credentials whose application no longer exists', async () => {
    await issueCredential(dao);
    database.exec('PRAGMA foreign_keys = OFF');
    database.prepare('DELETE FROM connected_applications WHERE application_id = ?').run(APP);
    database.exec('PRAGMA foreign_keys = ON');

    // The cascade normally handles this; this is a backstop for a row written
    // before the foreign key existed.
    expect(await dao.deleteOrphaned(10)).toBe(1);
  });
});
