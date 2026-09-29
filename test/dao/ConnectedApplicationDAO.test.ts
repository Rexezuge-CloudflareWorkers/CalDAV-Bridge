import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectedApplicationDAO } from '@caldav-bridge/backend-data/dao';
import { decryptData } from '@caldav-bridge/backend-data/crypto';
import { TimestampUtil } from '@caldav-bridge/shared/utils';
import { asD1Queryable } from '../helpers/d1';
import { applyMigrations } from '../helpers/migrations';

const MASTER_KEY = 'test-master-key-value-for-aes-256';
const USER_ID = 'user-1';
const OWNER = 'owner@example.com';

const CREDENTIALS = { clientId: 'client-id', clientSecret: 'client-secret', refreshToken: 'refresh-token' };

function openDatabase(): { database: DatabaseSync; dao: ConnectedApplicationDAO } {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  applyMigrations(database);
  database
    .prepare('INSERT INTO users (email, created_at, updated_at, user_id, current_email) VALUES (?, ?, ?, ?, ?)')
    .run(OWNER, 100, 100, USER_ID, OWNER);
  database.prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 1, ?)').run(OWNER, USER_ID, 100);
  return { database, dao: new ConnectedApplicationDAO(asD1Queryable(database), MASTER_KEY) };
}

async function createApplication(dao: ConnectedApplicationDAO): Promise<string> {
  const application = await dao.create(USER_ID, 'Primary', 'google-calendar', { ...CREDENTIALS });
  return application.applicationId;
}

describe('ConnectedApplicationDAO', () => {
  let database: DatabaseSync;
  let dao: ConnectedApplicationDAO;

  beforeEach(() => {
    ({ database, dao } = openDatabase());
  });

  /**
   * The stored `user_email` is the account's frozen anchor, and it carries a live
   * `FOREIGN KEY`. The DAO derives it from `user_id` rather than taking it as a
   * parameter, so the two keys cannot disagree.
   */
  it('derives the anchor from the account rather than trusting a passed-in address', async () => {
    const application = await dao.create(USER_ID, 'Primary', 'google-calendar', { ...CREDENTIALS });

    const row = database
      .prepare('SELECT user_id, user_email FROM connected_applications WHERE application_id = ?')
      .get(application.applicationId) as { user_id: string; user_email: string };

    expect(row.user_id).toBe(USER_ID);
    expect(row.user_email).toBe(OWNER);
  });

  it('starts as a draft, since OAuth2 has not run yet', async () => {
    const application = await dao.create(USER_ID, 'Primary', 'google-calendar', { ...CREDENTIALS });

    expect(application.status).toBe('draft');
  });

  it('encrypts the credentials at rest', async () => {
    const applicationId = await createApplication(dao);

    const row = database
      .prepare('SELECT encrypted_credentials, credentials_iv FROM connected_applications WHERE application_id = ?')
      .get(applicationId) as { encrypted_credentials: string; credentials_iv: string };

    // The client secret must not be readable in the column.
    expect(row.encrypted_credentials).not.toContain('client-secret');
    await expect(decryptData(row.encrypted_credentials, row.credentials_iv, MASTER_KEY)).resolves.toContain('client-secret');
  });

  it('returns the full application with decrypted credentials', async () => {
    const applicationId = await createApplication(dao);

    const application = await dao.getById(applicationId);

    expect(application?.credentials).toMatchObject(CREDENTIALS);
  });

  it('scopes a lookup to the owning account', async () => {
    const applicationId = await createApplication(dao);

    // Ownership is proven by account id, so it holds across an address change.
    // Matching on the address would lock a user out of their own applications the
    // moment they changed it.
    await expect(dao.getByIdForUser(applicationId, USER_ID)).resolves.toBeDefined();
    await expect(dao.getByIdForUser(applicationId, 'someone-else')).resolves.toBeUndefined();
  });

  it('returns nothing for an unknown application', async () => {
    await expect(dao.getById('no-such-application')).resolves.toBeUndefined();
  });

  it('keeps the refresh token when the client credentials are updated', async () => {
    const applicationId = await createApplication(dao);

    await dao.updateForUser(applicationId, USER_ID, 'Renamed', { clientId: 'new-id', clientSecret: 'new-secret' });

    const application = await dao.getById(applicationId);
    // Overwriting the credentials without carrying the refresh token forward
    // would silently disconnect the calendar: the next refresh would have
    // nothing to present.
    expect(application?.credentials.refreshToken).toBe('refresh-token');
    expect(application?.credentials.clientId).toBe('new-id');
    expect(application?.displayName).toBe('Renamed');
  });

  it('refuses to update an application the caller does not own', async () => {
    const applicationId = await createApplication(dao);

    await expect(
      dao.updateForUser(applicationId, 'someone-else', 'Hijacked', { clientId: 'x', clientSecret: 'y' }),
    ).resolves.toBeUndefined();

    const application = await dao.getById(applicationId);
    expect(application?.displayName).toBe('Primary');
  });

  it('rotates the refresh token without disturbing the rest of the credentials', async () => {
    const applicationId = await createApplication(dao);

    await dao.updateOAuth2RefreshToken(applicationId, 'rotated-token');

    const application = await dao.getById(applicationId);
    expect(application?.credentials.refreshToken).toBe('rotated-token');
    expect(application?.credentials.clientId).toBe('client-id');
  });

  it('ignores a refresh-token update for an application that does not exist', async () => {
    await expect(dao.updateOAuth2RefreshToken('no-such-application', 'token')).resolves.toBeUndefined();
  });

  it('marks an application connected and records the provider address', async () => {
    const applicationId = await createApplication(dao);

    await dao.markOAuth2Connected(applicationId, 'fresh-refresh', 'user@gmail.example');

    const application = await dao.getById(applicationId);
    expect(application?.status).toBe('connected');
    expect(application?.providerEmail).toBe('user@gmail.example');
    expect(application?.credentials.refreshToken).toBe('fresh-refresh');
    // A successful connection clears any error left by a previous attempt.
    expect(application?.lastError).toBeNull();
  });

  it('lists an account applications newest first', async () => {
    await dao.create(USER_ID, 'First', 'google-calendar', { ...CREDENTIALS });
    database.prepare('UPDATE connected_applications SET updated_at = 200 WHERE display_name = ?').run('First');
    await dao.create(USER_ID, 'Second', 'google-calendar', { ...CREDENTIALS });

    const listed = await dao.listMetadataByUserId(USER_ID);

    expect(listed.map((application) => application.displayName)).toEqual(['Second', 'First']);
  });

  it('lists only the caller own applications', async () => {
    await createApplication(dao);

    await expect(dao.listMetadataByUserId('someone-else')).resolves.toEqual([]);
  });

  it('does not return credentials from a metadata listing', async () => {
    await createApplication(dao);

    // The listing feeds the UI, which has no use for a client secret; returning
    // one here would ship it to the browser for every application listed.
    const [listed] = await dao.listMetadataByUserId(USER_ID);
    expect(listed).not.toHaveProperty('credentials');
  });

  it('counts an account applications', async () => {
    await createApplication(dao);
    await dao.create(USER_ID, 'Second', 'microsoft-outlook-calendar', { ...CREDENTIALS });

    await expect(dao.countByUserId(USER_ID)).resolves.toBe(2);
    await expect(dao.countByUserId('someone-else')).resolves.toBe(0);
  });

  it('deletes only an application the caller owns', async () => {
    const applicationId = await createApplication(dao);

    await dao.deleteForUser(applicationId, 'someone-else');
    await expect(dao.getById(applicationId)).resolves.toBeDefined();

    await dao.deleteForUser(applicationId, USER_ID);
    await expect(dao.getById(applicationId)).resolves.toBeUndefined();
  });

  it('cascades a deletion to everything the application owns', async () => {
    const applicationId = await createApplication(dao);
    database
      .prepare(
        `INSERT INTO caldav_credentials
          (credential_id, application_id, username, password_hash, name, password_prefix, password_last_four, created_at, expires_at)
         VALUES ('cred-1', ?, 'otter1234', 'hash', 'Laptop', 'cb_', 'abcd', 100, 9999999999)`,
      )
      .run(applicationId);

    await dao.deleteForUser(applicationId, USER_ID);

    // The foreign key is ON DELETE CASCADE, so the credential goes with it. Left
    // behind it would be a live CalDAV password for an account that no longer
    // exists.
    const remaining = database.prepare('SELECT COUNT(*) AS count FROM caldav_credentials').get() as { count: number };
    expect(remaining.count).toBe(0);
  });

  it('reaps draft applications older than the cutoff, and leaves connected ones', async () => {
    await dao.create(USER_ID, 'Stale draft', 'google-calendar', { ...CREDENTIALS });
    const applicationId = await createApplication(dao);
    await dao.markOAuth2Connected(applicationId, 'refresh', 'user@gmail.example');

    // The cutoff is a Unix-seconds instant; a value past "now" makes every row
    // eligible, which is what "old enough to reap" means for a draft.
    const deleted = await dao.deleteDraftsUpdatedBefore(TimestampUtil.getCurrentUnixTimestampInSeconds() + 1, 10);

    expect(deleted).toBe(1);
    // A connected application is real configuration, not a leftover, and
    // reaping it would disconnect a working calendar.
    await expect(dao.getById(applicationId)).resolves.toBeDefined();
  });

  it('leaves a draft newer than the cutoff alone', async () => {
    await dao.create(USER_ID, 'Fresh draft', 'google-calendar', { ...CREDENTIALS });

    // A half-configured application someone is still working on must survive.
    expect(await dao.deleteDraftsUpdatedBefore(1, 10)).toBe(0);
  });

  it('reaps drafts no further than the batch size', async () => {
    for (let index = 0; index < 5; index += 1) {
      await dao.create(USER_ID, `Draft ${index}`, 'google-calendar', { ...CREDENTIALS });
    }
    const cutoff = TimestampUtil.getCurrentUnixTimestampInSeconds() + 1;

    // Bounded so a single run cannot hold a long write lock on the table.
    expect(await dao.deleteDraftsUpdatedBefore(cutoff, 2)).toBe(2);
    expect(await dao.deleteDraftsUpdatedBefore(cutoff, 2)).toBe(2);
    expect(await dao.deleteDraftsUpdatedBefore(cutoff, 2)).toBe(1);
  });

  it('reaps applications whose account is gone', async () => {
    await createApplication(dao);
    database.exec('PRAGMA foreign_keys = OFF');
    database.prepare('DELETE FROM users WHERE user_id = ?').run(USER_ID);
    database.exec('PRAGMA foreign_keys = ON');

    // The cascade would normally handle this, so this is a backstop for a row
    // that predates the foreign key or was written with it unenforced.
    expect(await dao.deleteOrphaned(10)).toBe(1);
  });
});
