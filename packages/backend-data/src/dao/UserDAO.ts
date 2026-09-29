import { TimestampUtil, UUIDUtil } from '@caldav-bridge/shared/utils';
import type { D1Queryable } from '../utils';

interface UserRow {
  email: string;
  created_at: number;
  updated_at: number;
  /** Stable account key (migration 0004). Absent on rows written before it. */
  user_id?: string | null | undefined;
  /** Mutable login address (migration 0004). */
  current_email?: string | null | undefined;
}

/**
 * Accounts.
 *
 * `users.email` is the **frozen anchor**: it stays the PRIMARY KEY and is never
 * updated, because `connected_applications` carries a live
 * `FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE` that must
 * keep resolving. Identity is `user_id`; the sign-in address is `current_email`.
 */
class UserDAO {
  constructor(private readonly database: D1Queryable) {}

  /** Account ids are UUIDs, matching `application_id` and `credential_id`. */
  public static newId(): string {
    return UUIDUtil.getRandomUUID();
  }

  /**
   * Opaque anchor for accounts created after 0004.
   *
   * It must be globally unique and must never be a real address: the anchor
   * column is the primary key that `connected_applications.user_email` resolves
   * against, so an address used here could never be re-registered by a
   * different person after the original account changed addresses. `.invalid` is
   * reserved by RFC 6761 and can never be delivered to.
   */
  public static newAnchor(): string {
    return `anchor-${UUIDUtil.getRandomUUID().replace(/-/g, '')}@users.invalid`;
  }

  /**
   * Create an account, unless the anchor is already held.
   *
   * Returns the created row, or `undefined` when the anchor was taken. That
   * distinction is load-bearing: the anchor is the primary key that
   * `connected_applications.user_email` resolves against, so reusing one would
   * hand the previous holder's applications to whoever presents that address
   * next. Callers must therefore treat `undefined` as "pick another anchor"
   * rather than reading the row that is already there.
   */
  public async insertIfAbsent(anchor: string, currentEmail: string): Promise<UserRow | undefined> {
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const userId = UserDAO.newId();
    const result = await this.database
      .prepare(
        `
          INSERT INTO users (email, created_at, updated_at, user_id, current_email)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(email) DO NOTHING
        `,
      )
      .bind(anchor, now, now, userId, currentEmail.toLowerCase())
      .run();
    if (!result.meta?.changes) return undefined;
    return { email: anchor, created_at: now, updated_at: now, user_id: userId, current_email: currentEmail.toLowerCase() };
  }

  /** Heartbeat an existing account. */
  public async touch(userId: string): Promise<void> {
    await this.database
      .prepare('UPDATE users SET updated_at = ? WHERE user_id = ?')
      .bind(TimestampUtil.getCurrentUnixTimestampInSeconds(), userId)
      .run();
  }

  public async getByUserId(userId: string): Promise<UserRow | undefined> {
    const row = await this.database
      .prepare('SELECT email, created_at, updated_at, user_id, current_email FROM users WHERE user_id = ? LIMIT 1')
      .bind(userId)
      .first<UserRow>();
    return row ?? undefined;
  }

  /** Anchor lookup. Not a login path -- an anchor may belong to another account. */
  public async getByAnchorEmail(email: string): Promise<UserRow | undefined> {
    const row = await this.database
      .prepare('SELECT email, created_at, updated_at, user_id, current_email FROM users WHERE lower(email) = lower(?) LIMIT 1')
      .bind(email)
      .first<UserRow>();
    return row ?? undefined;
  }

  public async getByCurrentEmail(email: string): Promise<UserRow | undefined> {
    const row = await this.database
      .prepare('SELECT email, created_at, updated_at, user_id, current_email FROM users WHERE current_email = ? LIMIT 1')
      .bind(email.toLowerCase())
      .first<UserRow>();
    return row ?? undefined;
  }

  /**
   * Move the login address. The anchor is deliberately untouched: it is what
   * `connected_applications.user_email` resolves against, and updating it would
   * either trip the foreign key or cascade the account's applications away.
   */
  public async setCurrentEmail(userId: string, email: string): Promise<void> {
    await this.database
      .prepare('UPDATE users SET current_email = ?, updated_at = ? WHERE user_id = ?')
      .bind(email.toLowerCase(), TimestampUtil.getCurrentUnixTimestampInSeconds(), userId)
      .run();
  }

  public async deleteInactiveEmptyBefore(cutoff: number, limit: number): Promise<number> {
    const result = await this.database
      .prepare(
        `
          DELETE FROM users
          WHERE user_id IN (
            SELECT user_id
            FROM users
            WHERE updated_at < ?
              AND user_id IS NOT NULL
              AND user_id NOT IN (
                SELECT user_id FROM connected_applications WHERE user_id IS NOT NULL
              )
            LIMIT ?
          )
        `,
      )
      .bind(cutoff, limit)
      .run();
    return result.meta?.changes ?? 0;
  }
}

export { UserDAO };
export type { UserRow };
