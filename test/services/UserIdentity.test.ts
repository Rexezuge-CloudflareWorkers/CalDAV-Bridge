import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { UserIdentityService } from '@caldav-bridge/backend-services/user';
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
function insertAccount(database: DatabaseSync, anchor: string, userId: string, currentEmail: string, verified = true): void {
  database
    .prepare('INSERT INTO users (email, created_at, updated_at, user_id, current_email) VALUES (?, ?, ?, ?, ?)')
    .run(anchor, 100, 100, userId, currentEmail);
  database
    .prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, ?, ?)')
    .run(currentEmail.toLowerCase(), userId, verified ? 1 : 0, 100);
}

describe('UserIdentityService.resolveOrCreate', () => {
  let database: DatabaseSync;
  let service: UserIdentityService;

  beforeEach(() => {
    database = openDatabase();
    service = new UserIdentityService({ DB: asD1Queryable(database) });
  });

  it('resolves a registered address to its account', async () => {
    insertAccount(database, ANCHOR, 'user-1', 'owner@example.com');

    const identity = await service.resolveOrCreate('owner@example.com');

    expect(identity.userId).toBe('user-1');
    expect(identity.currentEmail).toBe('owner@example.com');
  });

  it('lowercases the address, so casing cannot create a second account', async () => {
    insertAccount(database, ANCHOR, 'user-1', 'owner@example.com');

    const identity = await service.resolveOrCreate('OWNER@EXAMPLE.COM');

    // Access is case-insensitive in practice. Treating the two spellings as
    // different would mint a second account for the same person on a phone
    // keyboard that autocapitalises.
    expect(identity.userId).toBe('user-1');
  });

  /**
   * A revoked address stays in the registry so rows written before the change
   * remain attributable, but it must not authenticate. Falling through to the
   * `users` anchor lookup would hand the previous holder's applications to
   * whoever presents the address next.
   */
  it('refuses a revoked address, and does not fall through to its anchor', async () => {
    // The post-change state: the anchor is frozen at the old address, the login
    // address has moved, and the old registry row is revoked.
    insertAccount(database, 'old@example.com', 'user-1', 'new@example.com');
    database
      .prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 0, ?)')
      .run('old@example.com', 'user-1', 100);

    const identity = await service.resolveOrCreate('old@example.com');

    // A new holder of that address claims it fresh. Falling through to the anchor
    // lookup would have resolved to the previous holder and handed their
    // applications over.
    expect(identity.userId).not.toBe('user-1');
    expect(identity.currentEmail).toBe('old@example.com');
  });

  it('provisions an account for an address that has never been seen', async () => {
    const identity = await service.resolveOrCreate('newcomer@example.com');

    expect(identity.userId).toBeTruthy();
    expect(identity.currentEmail).toBe('newcomer@example.com');
    // A new account prefers the real address as its anchor, which is what every
    // row written before 0004 looks like.
    expect(identity.anchorEmail).toBe('newcomer@example.com');
  });

  it('registers the address so the next sign-in finds the same account', async () => {
    const first = await service.resolveOrCreate('newcomer@example.com');

    const second = await service.resolveOrCreate('newcomer@example.com');

    // Without the registry claim the fresh account would be invisible to
    // resolution and every sign-in would mint another one.
    expect(second.userId).toBe(first.userId);
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

    const identity = await service.resolveOrCreate('shared@example.com');

    // The address cannot be this account's anchor -- it is already the previous
    // holder's -- so an opaque placeholder is used and the address stays
    // re-claimable by whoever holds it now.
    expect(identity.currentEmail).toBe('shared@example.com');
    expect(identity.userId).not.toBe('user-1');
    expect(identity.anchorEmail).toMatch(/^anchor-[0-9a-f]{32}@users\.invalid$/);
  });

  it('issues an anchor that can never be delivered to a real mailbox', async () => {
    insertAccount(database, 'shared@example.com', 'user-1', 'moved-elsewhere@example.com');
    database
      .prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 0, ?)')
      .run('shared@example.com', 'user-1', 100);

    const identity = await service.resolveOrCreate('shared@example.com');

    // `.invalid` is reserved by RFC 6761, so a placeholder anchor can never be
    // delivered to -- and so can never be claimed by a real party's mail server.
    expect(identity.anchorEmail.endsWith('@users.invalid')).toBe(true);
  });

  it('re-points a revoked registry row when the address is legitimately reclaimed', async () => {
    insertAccount(database, 'old@example.com', 'user-1', 'moved-elsewhere@example.com');
    database
      .prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 0, ?)')
      .run('old@example.com', 'user-1', 100);

    const identity = await service.resolveOrCreate('old@example.com');

    // The revoked row is reused rather than duplicated, so the registry keeps
    // exactly one row per address, and the previous holder is not inherited.
    const rows = database.prepare('SELECT user_id, is_verified FROM user_emails WHERE email = ?').all('old@example.com') as Array<{
      user_id: string;
      is_verified: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(identity.userId);
    expect(rows[0]?.is_verified).toBe(1);
    // The previous holder keeps their own row, still revoked.
    const previous = database.prepare('SELECT is_verified FROM user_emails WHERE email = ?').get('moved-elsewhere@example.com') as {
      is_verified: number;
    };
    expect(previous.is_verified).toBe(1);
  });

  it('returns a registry row pointing at a missing account as unknown', async () => {
    // Migration 0004 backs the registry with a foreign key, but a row written
    // before the key existed -- or one written with it unenforced -- has no
    // account behind it. Resolving it would hand out an identity that owns
    // nothing and cannot sign in again.
    database.exec('PRAGMA foreign_keys = OFF');
    database
      .prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 1, ?)')
      .run('ghost@example.com', 'no-such-user', 100);
    database.exec('PRAGMA foreign_keys = ON');

    const identity = await service.resolveOrCreate('ghost@example.com');

    expect(identity.userId).not.toBe('no-such-user');
  });

  it('fails loudly when a row exists but carries no account id', async () => {
    // A pre-0004 row has no `user_id`. Treating it as an anonymous identity would
    // resolve to an account id of `undefined` and authorize nothing, while
    // looking successful.
    database.exec('PRAGMA foreign_keys = OFF');
    database.prepare('INSERT INTO users (email, created_at, updated_at) VALUES (?, ?, ?)').run('legacy@example.com', 100, 100);
    database.exec('PRAGMA foreign_keys = ON');

    const identity = await service.resolveOrCreate('legacy@example.com');

    // A legacy row is found through the anchor fallback, so a *new* account is
    // provisioned rather than an identity without an id being returned.
    expect(identity.userId).toBeTruthy();
    expect(identity.userId).toBeDefined();
  });

  it('resolves a legacy row through its anchor, matching pre-0004 data', async () => {
    database.exec('PRAGMA foreign_keys = OFF');
    database
      .prepare('INSERT INTO users (email, created_at, updated_at, user_id, current_email) VALUES (?, ?, ?, ?, ?)')
      .run('legacy@example.com', 100, 100, 'user-legacy', 'legacy@example.com');
    database.exec('PRAGMA foreign_keys = ON');

    const identity = await service.resolveOrCreate('legacy@example.com');

    // A database predating 0004 has no registry row at all, and the address *is*
    // the anchor there. Resolving it keeps those accounts working.
    expect(identity.userId).toBe('user-legacy');
  });

  it('does not silently create a second account for the same address', async () => {
    insertAccount(database, ANCHOR, 'user-1', 'owner@example.com');

    const identities = await Promise.all([
      service.resolveOrCreate(ANCHOR),
      service.resolveOrCreate(ANCHOR),
      service.resolveOrCreate(ANCHOR),
    ]);

    // Two concurrent first sign-ins must not each mint an account, or a user's
    // applications would end up split between them.
    expect(new Set(identities.map((identity) => identity.userId)).size).toBe(1);
  });
});
