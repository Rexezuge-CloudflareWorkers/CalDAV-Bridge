-- Migration 0006: Converge the identity columns on the kit's vocabulary.
--
-- Account identity is the kit's `@rexezuge/identity` now, and every statement
-- in it is written against the canonical schema: `users.id` is the stable
-- account key and `username` is the optional handle. Migration 0004 named the
-- key `user_id`; this renames it so the kit's DAO runs unmodified instead of
-- this repo subclassing an override for every statement that mentions it.
--
-- `ALTER TABLE ... RENAME COLUMN` is what makes the rename safe. SQLite 3.25+
-- rewrites every reference to the renamed column, including the foreign key
-- clauses in `user_emails` and `connected_applications`, so
-- `REFERENCES users(user_id)` becomes `REFERENCES users(id)` -- and D1 never
-- has to turn foreign keys off (it cannot) or rebuild the table (the foreign
-- key makes that lossy).
--
-- `email` stays the PRIMARY KEY and the frozen anchor (see 0004): the live
-- `connected_applications.user_email` reference still resolves through it, and
-- nothing here touches its values. `username` is additive; the canonical schema
-- types it nullable, and this repo has no handle feature yet.
--
-- This is the shape the kit's own upgrade path (`UPGRADE_USER_IDENTITY`) leaves
-- a pre-existing database in: `id` is a unique-indexed plain column rather than
-- the primary key, because SQLite cannot add a PRIMARY KEY column. A unique
-- index is a valid foreign key parent, which is all the references need.
--
-- Index names converge on the kit's (`idx_users_id`, `idx_user_emails_user`),
-- so a database that ran 0004 and one stamped from the kit's fresh schema are
-- indistinguishable to introspection. `idx_connected_applications_user_id` is
-- this repo's own and stays.
--
-- Not re-runnable, like 0004's `ADD COLUMN`s: SQLite has no `RENAME COLUMN IF
-- EXISTS` and no `ADD COLUMN IF NOT EXISTS`. D1 records applied files, so it
-- never needs to be. The guards on the index statements only make a
-- partially-applied file repairable.

ALTER TABLE users RENAME COLUMN user_id TO id;

ALTER TABLE users ADD COLUMN username TEXT;

DROP INDEX IF EXISTS idx_users_user_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_id ON users(id);

DROP INDEX IF EXISTS idx_user_emails_user_id;
CREATE INDEX IF NOT EXISTS idx_user_emails_user ON user_emails(user_id);
