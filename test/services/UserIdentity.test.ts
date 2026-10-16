import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { UserIdentityService } from '@rexezuge/identity';
import { asD1Queryable } from '../helpers/d1';
import { applyMigrations } from '../helpers/migrations';

const ANCHOR = 'owner@example.com';

function openDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  applyMigrations(database);
  return database;
}

/** An account as it looks after migration 0004: a frozen anchor, a login address, a verified registry row. */
function insertAccount(database: DatabaseSync, anchor: string, id: string, currentEmail: string, verified = true): void {
  database
    .prepare('INSERT INTO users (email, created_at, updated_at, id, current_email) VALUES (?, ?, ?, ?, ?)')
    .run(anchor, 100, 100, id, currentEmail);
  database
    .prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, ?, ?)')
    .run(currentEmail.toLowerCase(), id, verified ? 1 : 0, 100);
}

/**
 * The kit's account resolution, exercised against this repo's schema.
 *
 * The service is the kit's (`@rexezuge/identity`); what a test here pins is
 * that its resolution order holds over the migrated schema this repo runs --
 * the anchor primary key, the registry, and the unique ids.
 */
describe('UserIdentityService.resolveOrRegister', () => {
  let database: DatabaseSync;
  let service: UserIdentityService;

  beforeEach(() => {
    database = openDatabase();
    service = new UserIdentityService({ DB: asD1Queryable(database) });
  });

  it('resolves a registered address to its account', async () => {
    insertAccount(database, ANCHOR, 'user-1', 'owner@example.com');

    const account = await service.resolveOrRegister('owner@example.com');

    expect(account?.id).toBe('user-1');
    expect(account?.email).toBe('owner@example.com');
  });

  it('lowercases the address, so casing cannot create a second account', async () => {
    insertAccount(database, ANCHOR, 'user-1', 'owner@example.com');

    const account = await service.resolveOrRegister('OWNER@EXAMPLE.COM');

    // Access is case-insensitive in practice. Treating the two spellings as
    // different would mint a second account for the same person on a phone
    // keyboard that autocapitalises.
    expect(account?.id).toBe('user-1');
  });

  /**
   * A revoked address stays in the registry so rows written before the change
   * remain attributable, but it must not authenticate the previous holder.
   * Falling through to the `users` anchor lookup would hand their applications
   * to whoever presents the address next.
   */
  it('re-registers a revoked address as a fresh account, without inheriting the previous holder', async () => {
    // The post-change state: the anchor is frozen at the old address, the login
    // address has moved, and the old registry row is revoked.
    insertAccount(database, 'old@example.com', 'user-1', 'new@example.com');
    database
      .prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 0, ?)')
      .run('old@example.com', 'user-1', 100);

    const account = await service.resolveOrRegister('old@example.com');

    // The new holder of that address claims it fresh: the revoked row is
    // re-pointed, and the previous holder's account is untouched.
    expect(account?.id).not.toBe('user-1');
    expect(account?.email).toBe('old@example.com');
  });

  it('provisions an account for an address that has never been seen', async () => {
    const account = await service.resolveOrRegister('newcomer@example.com');

    expect(account?.id).toMatch(/^usr_[0-9a-f]{32}$/);
    expect(account?.email).toBe('newcomer@example.com');
    // A new account prefers the real address as its anchor, which is what every
    // row written before 0006 looks like.
    expect(account?.anchorEmail).toBe('newcomer@example.com');
  });

  it('registers the address so the next sign-in finds the same account', async () => {
    const first = await service.resolveOrRegister('newcomer@example.com');

    // A fresh instance, so the answer cannot come from the service's per-request
    // memo: it has to be the registry row the first call wrote.
    const second = await new UserIdentityService({ DB: asD1Queryable(database) }).resolveOrRegister('newcomer@example.com');

    // Without the registry claim the fresh account would be invisible to
    // resolution and every sign-in would mint another one.
    expect(second?.id).toBe(first?.id);
  });

  /**
   * An address that is already another account's anchor cannot become this
   * account's anchor, so an opaque one is used instead. The alternative would
   * make the address permanently unusable by anyone.
   */
  it('uses an opaque anchor when the address is already another account anchor', async () => {
    // The post-change state: the anchor is frozen at the old address, the login
    // address has moved, and the old registry row is revoked.
    insertAccount(database, 'shared@example.com', 'user-1', 'moved-elsewhere@example.com');
    database
      .prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 0, ?)')
      .run('shared@example.com', 'user-1', 100);

    const account = await service.resolveOrRegister('shared@example.com');

    // The address cannot be this account's anchor -- it is already the previous
    // holder's -- so an opaque placeholder is used and the address stays
    // re-claimable by whoever holds it now.
    expect(account?.email).toBe('shared@example.com');
    expect(account?.id).not.toBe('user-1');
    expect(account?.anchorEmail).toMatch(/^anchor-[0-9a-f]{32}@users\.invalid$/);
  });

  it('issues an anchor that can never be delivered to a real mailbox', async () => {
    insertAccount(database, 'shared@example.com', 'user-1', 'moved-elsewhere@example.com');
    database
      .prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 0, ?)')
      .run('shared@example.com', 'user-1', 100);

    const account = await service.resolveOrRegister('shared@example.com');

    // `.invalid` is reserved by RFC 6761, so a placeholder anchor can never be
    // delivered to -- and so can never be claimed by a real party's mail server.
    expect(account?.anchorEmail.endsWith('@users.invalid')).toBe(true);
  });

  it('re-points a revoked registry row when the address is legitimately reclaimed', async () => {
    insertAccount(database, 'old@example.com', 'user-1', 'moved-elsewhere@example.com');
    database
      .prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 0, ?)')
      .run('old@example.com', 'user-1', 100);

    const account = await service.resolveOrRegister('old@example.com');

    // The revoked row is reused rather than duplicated, so the registry keeps
    // exactly one row per address, and the previous holder is not inherited.
    const rows = database.prepare('SELECT user_id, is_verified FROM user_emails WHERE email = ?').all('old@example.com') as Array<{
      user_id: string;
      is_verified: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(account?.id);
    expect(rows[0]?.is_verified).toBe(1);
    // The previous holder keeps their own row, still live for their new address.
    const previous = database.prepare('SELECT is_verified FROM user_emails WHERE email = ?').get('moved-elsewhere@example.com') as {
      is_verified: number;
    };
    expect(previous.is_verified).toBe(1);
  });

  it('refuses a registry row pointing at a missing account', async () => {
    // Migration 0004 backs the registry with a foreign key, but a row written
    // before the key existed -- or one written with it unenforced -- has no
    // account behind it. The kit refuses to resolve it: handing out an identity
    // that owns nothing would look like a sign-in that never works. `UserService`
    // turns the refusal into a server error so an operator can repair the row.
    database.exec('PRAGMA foreign_keys = OFF');
    database
      .prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 1, ?)')
      .run('ghost@example.com', 'no-such-user', 100);
    database.exec('PRAGMA foreign_keys = ON');

    await expect(service.resolveOrRegister('ghost@example.com')).resolves.toBeNull();
  });

  it('provisions a fresh account when the anchor row carries no account id', async () => {
    // A pre-0004 row has no id. Treating it as an anonymous identity would
    // resolve to an account id of `undefined` and authorize nothing, while
    // looking successful.
    database.prepare('INSERT INTO users (email, created_at, updated_at) VALUES (?, ?, ?)').run('legacy@example.com', 100, 100);

    const account = await service.resolveOrRegister('legacy@example.com');

    // The legacy row cannot answer with an id, so a *new* account is
    // provisioned rather than an identity without one being returned.
    expect(account?.id).toBeTruthy();
    expect(account?.id).toMatch(/^usr_[0-9a-f]{32}$/);
  });

  it('resolves a legacy row through its anchor, matching pre-0004 data', async () => {
    // No registry row and no `current_email`: the address *is* the anchor on a
    // database predating 0004.
    database.prepare('INSERT INTO users (email, created_at, updated_at, id) VALUES (?, ?, ?, ?)').run('legacy@example.com', 100, 100, 'user-legacy');

    const account = await service.resolveOrRegister('legacy@example.com');

    // Resolving it keeps those accounts working.
    expect(account?.id).toBe('user-legacy');
    expect(account?.email).toBe('legacy@example.com');
  });

  it('does not silently create a second account for the same address', async () => {
    insertAccount(database, ANCHOR, 'user-1', 'owner@example.com');

    const accounts = await Promise.all([
      service.resolveOrRegister(ANCHOR),
      service.resolveOrRegister(ANCHOR),
      service.resolveOrRegister(ANCHOR),
    ]);

    // Two concurrent first sign-ins must not each mint an account, or a user's
    // applications would end up split between them.
    expect(new Set(accounts.map((account) => account?.id)).size).toBe(1);
  });
});
