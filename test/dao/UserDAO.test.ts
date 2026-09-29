import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { asD1Queryable } from '../helpers/d1';
import { applyMigrations } from '../helpers/migrations';

const ALICE = 'alice@example.com';
const OPAQUE_ANCHOR = /^anchor-[0-9a-f]{32}@users\.invalid$/;

function openDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  applyMigrations(database);
  return database;
}

function insertUser(database: DatabaseSync, anchor: string, userId: string, currentEmail: string, now = 100): void {
  database
    .prepare('INSERT INTO users (email, created_at, updated_at, user_id, current_email) VALUES (?, ?, ?, ?, ?)')
    .run(anchor, now, now, userId, currentEmail);
}

/**
 * An account as production writes it: a frozen anchor, a current sign-in address,
 * and a verified registry row claiming that address.
 */
function insertAccount(database: DatabaseSync, anchor: string, userId: string, currentEmail: string, now = 100): void {
  insertUser(database, anchor, userId, currentEmail, now);
  database
    .prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 1, ?)')
    .run(currentEmail.toLowerCase(), userId, now);
}

describe('UserDAO', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openDatabase();
  });

  it('mints account ids that are UUIDs and anchors that can never be delivered', async () => {
    const { UserDAO } = await import('@caldav-bridge/backend-data/dao');

    expect(UserDAO.newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // The anchor is the primary key that `connected_applications.user_email`
    // resolves against, so it must never be an address anyone could register.
    expect(UserDAO.newAnchor()).toMatch(OPAQUE_ANCHOR);
    expect(UserDAO.newAnchor()).not.toBe(UserDAO.newAnchor());
  });

  it('creates an account and reports the row it actually created', async () => {
    const { UserDAO } = await import('@caldav-bridge/backend-data/dao');
    const dao = new UserDAO(asD1Queryable(database));

    const row = await dao.insertIfAbsent('Alice@Example.com', 'alice@example.com');

    expect(row?.user_id).toBeTruthy();
    expect(row?.current_email).toBe('alice@example.com');
    expect(row?.email).toBe('Alice@Example.com');
    expect(database.prepare('SELECT COUNT(*) AS c FROM users').get()?.c).toBe(1);
  });

  it('reports a taken anchor instead of returning the previous holder', async () => {
    const { UserDAO } = await import('@caldav-bridge/backend-data/dao');
    const dao = new UserDAO(asD1Queryable(database));
    insertUser(database, ALICE, 'alice-uuid', ALICE);

    // Returning the existing row here would let the registry claim point the
    // address at someone else's account.
    await expect(dao.insertIfAbsent(ALICE, ALICE)).resolves.toBeUndefined();
    expect(database.prepare('SELECT COUNT(*) AS c FROM users').get()?.c).toBe(1);
  });

  it('moves the login address without touching the frozen anchor', async () => {
    const { UserDAO } = await import('@caldav-bridge/backend-data/dao');
    const dao = new UserDAO(asD1Queryable(database));
    insertUser(database, ALICE, 'alice-uuid', ALICE);

    await dao.setCurrentEmail('alice-uuid', 'Alice.New@Example.com');

    const row = database.prepare('SELECT email, current_email FROM users WHERE user_id = ?').get('alice-uuid') as Record<string, string>;
    expect(row['current_email']).toBe('alice.new@example.com');
    // The anchor is what the legacy foreign key resolves against; changing it
    // would either trip the constraint or cascade the applications away.
    expect(row['email']).toBe(ALICE);
  });

  it('resolves an address case-insensitively through the registry and the anchor', async () => {
    const { UserDAO } = await import('@caldav-bridge/backend-data/dao');
    const dao = new UserDAO(asD1Queryable(database));
    insertUser(database, 'Alice@Example.com', 'alice-uuid', 'alice@example.com');

    expect((await dao.getByCurrentEmail('ALICE@EXAMPLE.COM'))?.user_id).toBe('alice-uuid');
    expect((await dao.getByAnchorEmail('alice@example.com'))?.user_id).toBe('alice-uuid');
    expect((await dao.getByUserId('alice-uuid'))?.current_email).toBe('alice@example.com');
    expect(await dao.getByUserId('missing')).toBeUndefined();
  });

  it('reaps only inactive users who own no applications', async () => {
    const { UserDAO } = await import('@caldav-bridge/backend-data/dao');
    const dao = new UserDAO(asD1Queryable(database));
    // Two empty accounts, both stale: both are reaped.
    insertAccount(database, 'idle@example.com', 'idle-uuid', 'idle@example.com', 1);
    insertAccount(database, 'also-idle@example.com', 'idle2-uuid', 'also-idle@example.com', 1);
    // Empty but recently active: retained.
    insertAccount(database, 'recent@example.com', 'recent-uuid', 'recent@example.com', 500);
    // Stale and owns an application: retained, since deleting it would cascade
    // the application -- and everything under it -- away.
    insertAccount(database, 'busy@example.com', 'busy-uuid', 'busy@example.com', 1);
    database
      .prepare(
        `INSERT INTO connected_applications
           (application_id, user_id, user_email, provider_email, display_name, provider_id, connection_method, encrypted_credentials, credentials_iv, status, last_error, created_at, updated_at)
         VALUES ('app-1', 'busy-uuid', 'busy@example.com', null, 'Busy', 'google-calendar', 'oauth2', 'enc', 'iv', 'draft', null, 1, 1)`,
      )
      .run();

    const deleted = await dao.deleteInactiveEmptyBefore(50, 10);

    expect(deleted).toBe(2);
    const remaining = database.prepare('SELECT user_id FROM users ORDER BY user_id').all() as Array<{ user_id: string }>;
    expect(remaining.map((row) => row.user_id)).toEqual(['busy-uuid', 'recent-uuid']);
    expect(database.prepare('SELECT COUNT(*) AS c FROM connected_applications').get()?.c).toBe(1);
  });

  it('reaps in batches so a large backlog is worked off over several runs', async () => {
    const { UserDAO } = await import('@caldav-bridge/backend-data/dao');
    const dao = new UserDAO(asD1Queryable(database));
    for (let index = 0; index < 5; index += 1) {
      insertAccount(database, `stale-${index}@example.com`, `stale-${index}`, `stale-${index}@example.com`, 1);
    }

    expect(await dao.deleteInactiveEmptyBefore(50, 2)).toBe(2);
    expect(await dao.deleteInactiveEmptyBefore(50, 2)).toBe(2);
    expect(await dao.deleteInactiveEmptyBefore(50, 2)).toBe(1);
    expect(await dao.deleteInactiveEmptyBefore(50, 2)).toBe(0);
    expect(database.prepare('SELECT COUNT(*) AS c FROM users').get()?.c).toBe(0);
  });
});

describe('UserEmailDAO', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openDatabase();
    insertAccount(database, ALICE, 'alice-uuid', ALICE);
    insertAccount(database, 'bob@example.com', 'bob-uuid', 'bob@example.com');
  });

  it('claims an address for an existing account and resolves it case-insensitively', async () => {
    const { UserEmailDAO } = await import('@caldav-bridge/backend-data/dao');
    const dao = new UserEmailDAO(asD1Queryable(database));

    expect(await dao.register({ email: 'Alice.New@Example.com', userId: 'alice-uuid', isVerified: true })).toBe('claimed');

    const resolved = await dao.resolveVerified('ALICE.NEW@example.com');
    expect(resolved?.user_id).toBe('alice-uuid');
    expect(resolved?.is_verified).toBe(1);
  });

  it('refuses to register an address that no account holds', async () => {
    const { UserEmailDAO } = await import('@caldav-bridge/backend-data/dao');
    const dao = new UserEmailDAO(asD1Queryable(database));

    // The registry references `users(user_id)`, so an unbacked id is rejected by
    // the database rather than creating an orphan address row.
    await expect(dao.register({ email: 'carol@example.com', userId: 'no-such-account', isVerified: true })).rejects.toThrow();
  });

  it('refuses to re-point a verified address held by another account', async () => {
    const { UserEmailDAO } = await import('@caldav-bridge/backend-data/dao');
    const dao = new UserEmailDAO(asD1Queryable(database));

    expect(await dao.register({ email: ALICE, userId: 'alice-uuid', isVerified: true })).toBe('already-claimed');
    // Bob must not be able to take it by registering again.
    expect(await dao.register({ email: ALICE, userId: 'bob-uuid', isVerified: true })).toBe('already-claimed');
    expect((await dao.resolveVerified(ALICE))?.user_id).toBe('alice-uuid');
  });

  it('releases a revoked address for re-registration', async () => {
    const { UserEmailDAO } = await import('@caldav-bridge/backend-data/dao');
    const dao = new UserEmailDAO(asD1Queryable(database));
    await dao.register({ email: 'recycled@example.com', userId: 'alice-uuid', isVerified: true });
    await dao.revoke('recycled@example.com');

    expect(await dao.resolveVerified('recycled@example.com')).toBeUndefined();
    // A revoked row is re-pointed, never deleted, so an address is not reserved
    // forever by whoever held it first.
    expect(await dao.register({ email: 'recycled@example.com', userId: 'bob-uuid', isVerified: true })).toBe('claimed');
    expect((await dao.resolveVerified('recycled@example.com'))?.user_id).toBe('bob-uuid');
  });

  it('revokes every other verified address for an account', async () => {
    const { UserEmailDAO } = await import('@caldav-bridge/backend-data/dao');
    const dao = new UserEmailDAO(asD1Queryable(database));
    await dao.register({ email: 'alice.new@example.com', userId: 'alice-uuid', isVerified: true });

    await dao.revokeAllVerified('alice-uuid', 'alice.new@example.com');

    expect(await dao.resolveVerified(ALICE)).toBeUndefined();
    expect((await dao.resolveVerified('alice.new@example.com'))?.user_id).toBe('alice-uuid');
    // Bob is untouched: revoking is scoped to one account.
    expect((await dao.resolveVerified('bob@example.com'))?.user_id).toBe('bob-uuid');
  });

  it("lists an account's addresses with the live one first", async () => {
    const { UserEmailDAO } = await import('@caldav-bridge/backend-data/dao');
    const dao = new UserEmailDAO(asD1Queryable(database));
    // Registered by the migration backfill (created_at 100), not by `register`,
    // so its ordering is the one the DAO actually has to cope with.
    await dao.register({ email: 'alice.old@example.com', userId: 'alice-uuid', isVerified: true, createdAt: 50 });
    await dao.revoke('alice.old@example.com');

    const rows = await dao.listByUserId('alice-uuid');

    expect(rows.map((row) => [row.email, row.is_verified])).toEqual([
      [ALICE, 1],
      ['alice.old@example.com', 0],
    ]);
  });
});
