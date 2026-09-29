import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectedApplicationDAO } from '@caldav-bridge/backend-data/dao';
import { asD1Queryable } from '../helpers/d1';
import { applyMigrations } from '../helpers/migrations';

const MASTER_KEY = 'AES-GCM test key for connected application credentials';

const ALICE_ANCHOR = 'Alice@Example.com';
const ALICE = 'alice@example.com';
const ALICE_UUID = '11111111-1111-4111-8111-111111111111';
const BOB_UUID = '22222222-2222-4222-8222-222222222222';

function openDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  applyMigrations(database);
  insertAccount(database, ALICE_ANCHOR, ALICE_UUID, ALICE);
  insertAccount(database, 'bob@example.com', BOB_UUID, 'bob@example.com');
  return database;
}

function insertAccount(database: DatabaseSync, anchor: string, userId: string, currentEmail: string): void {
  database
    .prepare('INSERT INTO users (email, created_at, updated_at, user_id, current_email) VALUES (?, 100, 100, ?, ?)')
    .run(anchor, userId, currentEmail);
  database
    .prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 1, 100)')
    .run(currentEmail.toLowerCase(), userId);
}

const CREDENTIALS = { clientId: 'client-id', clientSecret: 'client-secret' };

describe('ConnectedApplicationDAO', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openDatabase();
  });

  function dao(): ConnectedApplicationDAO {
    return new ConnectedApplicationDAO(asD1Queryable(database), MASTER_KEY);
  }

  it('stores the account id and derives the anchor from it', async () => {
    // The `user_email` column must satisfy `FOREIGN KEY (user_email) REFERENCES
    // users(email)`, so it is derived in SQL rather than passed in -- two keys
    // supplied separately could disagree and orphan the row.
    const application = await dao().create(ALICE_UUID, 'My Calendar', 'google-calendar', CREDENTIALS);

    expect(application.userId).toBe(ALICE_UUID);
    const row = database
      .prepare('SELECT user_id, user_email FROM connected_applications WHERE application_id = ?')
      .get(application.applicationId) as Record<string, string>;
    expect(row['user_id']).toBe(ALICE_UUID);
    expect(row['user_email']).toBe(ALICE_ANCHOR);
    // The anchor is never exposed as metadata, so it cannot leak into an API
    // response as display data.
    expect(JSON.stringify(application)).not.toContain(ALICE_ANCHOR);
    expect(JSON.stringify(application)).not.toContain('userEmail');
  });

  it('lists and counts applications by account id', async () => {
    await dao().create(ALICE_UUID, 'One', 'google-calendar', CREDENTIALS);
    await dao().create(ALICE_UUID, 'Two', 'microsoft-outlook-calendar', CREDENTIALS);
    await dao().create(BOB_UUID, 'Bobs', 'google-calendar', CREDENTIALS);

    const alices = await dao().listMetadataByUserId(ALICE_UUID);

    expect(alices).toHaveLength(2);
    expect(alices.every((row) => row.userId === ALICE_UUID)).toBe(true);
    expect(await dao().countByUserId(ALICE_UUID)).toBe(2);
    expect(await dao().countByUserId(BOB_UUID)).toBe(1);
  });

  it('keeps an account owner after the address changes', async () => {
    const application = await dao().create(ALICE_UUID, 'My Calendar', 'google-calendar', CREDENTIALS);

    // Alice moves to a new address. Her applications are keyed on the account id,
    // so ownership -- and access to them -- is unaffected.
    const { UserDAO } = await import('@caldav-bridge/backend-data/dao');
    await new UserDAO(asD1Queryable(database)).setCurrentEmail(ALICE_UUID, 'alice.new@example.com');

    expect((await dao().getByIdForUser(application.applicationId, ALICE_UUID))?.applicationId).toBe(application.applicationId);
    expect(await dao().listMetadataByUserId(ALICE_UUID)).toHaveLength(1);
    // The frozen anchor is what the legacy foreign key resolves against, so it
    // must be untouched by the address change.
    const row = database
      .prepare('SELECT user_email FROM connected_applications WHERE application_id = ?')
      .get(application.applicationId) as Record<string, string>;
    expect(row['user_email']).toBe(ALICE_ANCHOR);
  });

  it('refuses another account an application it does not own', async () => {
    const application = await dao().create(ALICE_UUID, 'My Calendar', 'google-calendar', CREDENTIALS);

    expect(await dao().getByIdForUser(application.applicationId, BOB_UUID)).toBeUndefined();
    expect(await dao().updateForUser(application.applicationId, BOB_UUID, 'Hijacked', CREDENTIALS)).toBeUndefined();

    await dao().deleteForUser(application.applicationId, BOB_UUID);
    // Bob's delete must not have taken Alice's row with it.
    expect(database.prepare('SELECT COUNT(*) AS c FROM connected_applications').get()?.c).toBe(1);
  });

  it('round-trips credentials through encryption', async () => {
    const application = await dao().create(ALICE_UUID, 'My Calendar', 'google-calendar', CREDENTIALS);

    const loaded = await dao().getById(application.applicationId);

    expect(loaded?.credentials).toEqual(CREDENTIALS);
    // Credentials are never stored in the clear.
    const stored = database
      .prepare('SELECT encrypted_credentials, credentials_iv FROM connected_applications WHERE application_id = ?')
      .get(application.applicationId) as Record<string, string>;
    expect(stored['encrypted_credentials']).not.toContain('client-secret');
  });

  it('reaps orphaned applications that reference a missing account', async () => {
    const application = await dao().create(ALICE_UUID, 'My Calendar', 'google-calendar', CREDENTIALS);
    const bobApplication = await dao().create(BOB_UUID, 'Bobs', 'google-calendar', CREDENTIALS);

    // Orphaning has to happen by way of the account, because the foreign keys
    // prevent an application from pointing at an account that does not exist.
    // Dropping the users rows directly is what a bad restore would leave behind.
    database.exec('PRAGMA foreign_keys = OFF');
    database.prepare('DELETE FROM users WHERE user_id IN (?, ?)').run(ALICE_UUID, BOB_UUID);
    database.exec('PRAGMA foreign_keys = ON');

    const deleted = await dao().deleteOrphaned(10);

    expect(deleted).toBe(2);
    expect(database.prepare('SELECT COUNT(*) AS c FROM connected_applications').get()?.c).toBe(0);
    expect(database.prepare('SELECT application_id FROM connected_applications').all()).toEqual([]);
    expect(application.applicationId).not.toBe(bobApplication.applicationId);
  });

  it('reaps orphaned applications in bounded batches', async () => {
    for (let index = 0; index < 3; index += 1) {
      await dao().create(ALICE_UUID, `App ${index}`, 'google-calendar', CREDENTIALS);
    }
    database.exec('PRAGMA foreign_keys = OFF');
    database.prepare('DELETE FROM users WHERE user_id = ?').run(ALICE_UUID);
    database.exec('PRAGMA foreign_keys = ON');

    expect(await dao().deleteOrphaned(2)).toBe(2);
    expect(await dao().deleteOrphaned(2)).toBe(1);
    expect(await dao().deleteOrphaned(2)).toBe(0);
  });
});
