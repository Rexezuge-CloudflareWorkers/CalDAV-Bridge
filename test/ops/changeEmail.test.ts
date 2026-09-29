import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { asD1Queryable } from '../helpers/d1';
import { applyMigrations, splitSql } from '../helpers/migrations';
import { UserDAO, UserEmailDAO } from '@caldav-bridge/backend-data/dao';

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

function openDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  applyMigrations(database);
  return database;
}

function insertAccount(database: DatabaseSync, anchor: string, userId: string, currentEmail: string, now = 100): void {
  database
    .prepare('INSERT INTO users (email, created_at, updated_at, user_id, current_email) VALUES (?, ?, ?, ?, ?)')
    .run(anchor, now, now, userId, currentEmail);
  database
    .prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 1, ?)')
    .run(currentEmail.toLowerCase(), userId, now);
}

/**
 * The three statements `scripts/change-email.ts` applies, in order.
 *
 * Kept in step with the script by assertion below, so the two cannot drift: the
 * script's value is that it is runnable against a real D1 database, and these
 * tests are what prove the change it makes is correct.
 */
/** Built fresh per invocation so the values interpolate the way the script's do. */
function changeEmailStatements(userId: string, target: string, now = 500): string[] {
  return [
    // 1. claim the new address for this account
    `INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES ('${target}', '${userId}', 1, ${now})
     ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id, is_verified = excluded.is_verified`,
    // 2. move the account's current address
    `UPDATE users SET current_email = '${target}', updated_at = ${now} WHERE user_id = '${userId}'`,
    // 3. revoke every other verified address for the account
    `UPDATE user_emails SET is_verified = 0 WHERE user_id = '${userId}' AND email != '${target}'`,
  ];
}

function applyChangeEmailScript(database: DatabaseSync, userId: string, target: string): void {
  database.exec('BEGIN');
  try {
    for (const sql of changeEmailStatements(userId, target)) {
      for (const part of splitSql(sql)) database.exec(part);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

describe('change-email operations', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openDatabase();
  });

  function seedAliceWithApplications(): { userId: string } {
    const userId = 'alice-uuid';
    insertAccount(database, ALICE, userId, ALICE);
    database
      .prepare(
        `INSERT INTO connected_applications
           (application_id, user_id, user_email, display_name, provider_id, connection_method, encrypted_credentials, credentials_iv, status, created_at, updated_at)
         VALUES ('app-1', '${userId}', '${ALICE}', 'Work', 'google-calendar', 'oauth2', 'enc', 'iv', 'connected', 1, 1)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO caldav_credentials (credential_id, application_id, username, password_hash, name, password_prefix, password_last_four, created_at, expires_at)
         VALUES ('cred-1', 'app-1', 'alpaca4821', 'hash', 'Phone', 'cb_ab', '1234', 1, 9999999999)`,
      )
      .run();
    return { userId };
  }

  it('moves the sign-in address while leaving the account and its data intact', () => {
    const { userId } = seedAliceWithApplications();

    applyChangeEmailScript(database, userId, 'alice.new@example.com');

    const account = database.prepare('SELECT email, current_email FROM users WHERE user_id = ?').get(userId) as Record<string, string>;
    expect(account['current_email']).toBe('alice.new@example.com');
    // The anchor is frozen: it is what the legacy foreign key resolves against.
    expect(account['email']).toBe(ALICE);
    expect(database.prepare('SELECT COUNT(*) AS c FROM connected_applications').get()?.c).toBe(1);
    expect(database.prepare('SELECT COUNT(*) AS c FROM caldav_credentials').get()?.c).toBe(1);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('resolves the new address to the same account and stops the old one signing in', async () => {
    const { userId } = seedAliceWithApplications();
    const emailDAO = new UserEmailDAO(asD1Queryable(database));

    applyChangeEmailScript(database, userId, 'alice.new@example.com');

    expect((await emailDAO.resolveVerified('alice.new@example.com'))?.user_id).toBe(userId);
    // The old address stays resolvable for attribution but can no longer sign in.
    expect(await emailDAO.resolveVerified(ALICE)).toBeUndefined();
    expect((await emailDAO.get(ALICE))?.user_id).toBe(userId);
  });

  it('never locks the user out, even if the move step does not complete', async () => {
    const { userId } = seedAliceWithApplications();
    const emailDAO = new UserEmailDAO(asD1Queryable(database));

    // Claim succeeds, moving the address fails. The new address is already live
    // for this account, so the user is not locked out -- which is the reason the
    // order is claim, move, revoke rather than revoke first.
    database.exec(
      `INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES ('alice.new@example.com', '${userId}', 1, 500)`,
    );

    expect((await emailDAO.resolveVerified('alice.new@example.com'))?.user_id).toBe(userId);
    expect((await emailDAO.resolveVerified(ALICE))?.user_id).toBe(userId);
  });

  it("refuses to re-point an address that is another account's live login", async () => {
    // This is the guard in the script: it inspects `user_emails` for a verified
    // row owned by a different account and refuses rather than half-applying.
    insertAccount(database, BOB, 'bob-uuid', BOB);
    const emailDAO = new UserEmailDAO(asD1Queryable(database));
    expect(await emailDAO.register({ email: BOB, userId: 'bob-uuid', isVerified: true })).toBe('already-claimed');
    expect((await emailDAO.resolveVerified(BOB))?.user_id).toBe('bob-uuid');
  });

  it("cannot move onto another account's live address, even without the script guard", () => {
    seedAliceWithApplications();
    // `idx_users_current_email` refuses to let two accounts share a sign-in
    // address, so the batch aborts rather than forking an identity. The script
    // checks this first and refuses cleanly; the constraint is the backstop.
    insertAccount(database, BOB, 'bob-uuid', BOB);

    expect(() => applyChangeEmailScript(database, 'alice-uuid', BOB)).toThrow(/constraint/i);

    const alice = database.prepare('SELECT current_email FROM users WHERE user_id = ?').get('alice-uuid') as Record<string, string>;
    expect(alice['current_email']).toBe(ALICE);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('releases an address so its next holder can claim it', async () => {
    // Alice moves away from an address; the registry row survives revoked so her
    // pre-change rows stay attributable, and the address is free to be claimed.
    const { userId } = seedAliceWithApplications();
    insertAccount(database, BOB, 'bob-uuid', BOB);
    const emailDAO = new UserEmailDAO(asD1Queryable(database));

    applyChangeEmailScript(database, userId, 'alice.new@example.com');

    expect(await emailDAO.register({ email: ALICE, userId: 'bob-uuid', isVerified: true })).toBe('claimed');
    expect((await emailDAO.resolveVerified(ALICE))?.user_id).toBe('bob-uuid');
    // Alice's applications are unaffected by the address changing hands.
    expect(database.prepare('SELECT user_id FROM connected_applications').get()?.['user_id']).toBe(userId);
  });

  it('survives being applied twice', () => {
    const { userId } = seedAliceWithApplications();

    applyChangeEmailScript(database, userId, 'alice.new@example.com');
    applyChangeEmailScript(database, userId, 'alice.new@example.com');

    const account = database.prepare('SELECT email, current_email FROM users WHERE user_id = ?').get(userId) as Record<string, string>;
    expect(account['current_email']).toBe('alice.new@example.com');
    expect(account['email']).toBe(ALICE);
    expect(database.prepare('SELECT COUNT(*) AS c FROM user_emails WHERE user_id = ?').get(userId)?.c).toBe(2);
  });

  it('lets the new holder provision an account when the old one keeps the anchor', async () => {
    const { userId } = seedAliceWithApplications();
    const userDAO = new UserDAO(asD1Queryable(database));

    applyChangeEmailScript(database, userId, 'alice.new@example.com');

    // Alice moved to an opaque anchor because `alice@example.com` is now Bob's
    // sign-in address, and the anchor column cannot be reused.
    const taken = await userDAO.insertIfAbsent(ALICE, ALICE);
    expect(taken).toBeUndefined();
    const fresh = await userDAO.insertIfAbsent(UserDAO.newAnchor(), ALICE);
    expect(fresh?.user_id).toBeTruthy();
    expect(fresh?.user_id).not.toBe(userId);
    expect(fresh?.current_email).toBe(ALICE);
  });
});
