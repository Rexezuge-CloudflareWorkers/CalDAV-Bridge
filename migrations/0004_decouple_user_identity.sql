-- Migration 0004: Decouple the user identifier from the email address.
--
-- Before this migration `users.email` was the PRIMARY KEY *and* the identity
-- key of `connected_applications`, so the address was the account. It could not
-- be changed: `connected_applications` carries a live
-- `FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE`, so
-- rewriting an address either tripped the constraint or cascaded the user's
-- connected applications away -- and with them every CalDAV credential,
-- calendar mapping, OAuth2 session and refresh token under them.
--
-- After this migration:
--   * `users.user_id` is the stable account key.
--   * `users.current_email` is the mutable login address.
--   * `users.email` becomes the frozen *anchor* address. It is never updated,
--     so the existing foreign key and every existing `user_email` value keeps
--     resolving forever, and no table has to be rebuilt.
--   * `user_emails` is the address registry: an address maps to an account,
--     `is_verified = 1` means "may be used to log in". A changed-from address
--     is retained with `is_verified = 0` so the account stays attributable
--     while the address stops authenticating, and it is released for
--     re-registration by a later account.
--   * `connected_applications.user_id` is the new identity key. Its `user_email`
--     column stays as the denormalized anchor copy that the foreign key needs:
--     still written, no longer the identity.
--
-- Why the address stays in `users` at all: D1 enforces foreign keys through the
-- Worker binding and honours neither `PRAGMA foreign_keys = off` nor
-- `PRAGMA legacy_alter_table = on`. Since SQLite rewrites a child's foreign key
-- clause when the parent is renamed, and drops a parent by cascading, the
-- reference to `users(email)` cannot be repointed without losing rows. Keeping
-- `email` as a frozen anchor sidesteps the rebuild entirely: this migration is
-- purely additive, and no `DROP TABLE` + `RENAME` appears anywhere in it.
--
-- This migration ABORTS if two existing users differ only by the case of their
-- address (`Alice@Example.com` and `alice@example.com`), because
-- `current_email` is lowercased for every account and
-- `idx_users_current_email` then cannot be created. Nothing is lost when it
-- aborts: `wrangler d1 migrations apply` runs each file in a transaction, so
-- the whole file rolls back. Inspect the duplicates with
-- `pnpm exec tsx scripts/change-email.ts --audit`, resolve them deliberately,
-- then re-run.
--
-- Rerunnable in the sense that matters: every *data* backfill is guarded by
-- `IS NULL` / `INSERT OR IGNORE` and every index uses `IF NOT EXISTS`, so
-- re-applying the backfill cannot mint new ids, relink applications or fail.
-- `ALTER TABLE ... ADD COLUMN` is not re-runnable in SQLite, and D1 records
-- applied files so it never needs to be.

-- ============================================================
-- Phase 1: stable account key
-- ============================================================
-- SQLite cannot add a PRIMARY KEY column, so `user_id` is a plain column with a
-- unique index. A unique index is a valid foreign key parent, which is all the
-- `connected_applications.user_id` reference below needs.
--
-- The backfill builds a v4-shaped UUID out of `randomblob` so ids generated in
-- SQL are indistinguishable from `UUIDUtil.getRandomUUID()`. `randomblob()`
-- requires an explicit length in SQLite, so the version nibble uses
-- `abs(randomblob(4)) % 4` rather than the more commonly quoted
-- `abs(randomblob()) % 4`, which is an argument error.
ALTER TABLE users ADD COLUMN user_id TEXT;

UPDATE users
SET user_id = lower(
  hex(randomblob(4)) || '-' ||
  hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
  substr('89ab', 1 + (abs(randomblob(4)) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
  hex(randomblob(6))
)
WHERE user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id);

-- ============================================================
-- Phase 2: mutable login address
-- ============================================================
-- `email` stays as the frozen anchor (see the header note); `current_email` is
-- what the account signs in with and what the API reports. Uniqueness is
-- enforced here, so an address can never be claimed by two accounts -- and
-- applying this backfill is exactly what aborts the migration on case-variant
-- duplicates.
--
-- `email` is skipped when NULL. `TEXT PRIMARY KEY` without `WITHOUT ROWID` is
-- one of SQLite's legacy quirks: it still admits a NULL primary key.
ALTER TABLE users ADD COLUMN current_email TEXT;

UPDATE users SET current_email = lower(email) WHERE current_email IS NULL AND email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_current_email ON users(current_email);

-- ============================================================
-- Phase 3: address registry
-- ============================================================
-- Login resolution consults `is_verified = 1` only. Backfilled from the frozen
-- anchor address of every existing account, lowercased so a legacy mixed-case
-- row still yields exactly one login identity.
CREATE TABLE IF NOT EXISTS user_emails (
  email TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  is_verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_emails_user_id ON user_emails(user_id);

INSERT OR IGNORE INTO user_emails (email, user_id, is_verified, created_at)
SELECT lower(email), user_id, 1, created_at FROM users WHERE email IS NOT NULL;

-- ============================================================
-- Phase 4: user_id on every user-keyed table
-- ============================================================
-- `connected_applications` is the only table that references a user. Additive
-- only: `ALTER TABLE ... ADD COLUMN`, then a backfill that resolves each stored
-- address through the registry. Resolving via `user_emails` rather than
-- `users.email` means an address also resolves once it has been linked as an
-- alias, and the lowercased join is case-insensitive by construction.
--
-- An address that matches no account leaves `user_id` NULL. That is
-- intentional rather than expected: the column stays nullable so the DAO can
-- fall back to the `user_email` read instead of dropping the row.
ALTER TABLE connected_applications ADD COLUMN user_id TEXT REFERENCES users(user_id);

UPDATE connected_applications
SET user_id = (
  SELECT ue.user_id
  FROM user_emails ue
  WHERE ue.email = lower(connected_applications.user_email)
  LIMIT 1
);

CREATE INDEX IF NOT EXISTS idx_connected_applications_user_id ON connected_applications(user_id);
