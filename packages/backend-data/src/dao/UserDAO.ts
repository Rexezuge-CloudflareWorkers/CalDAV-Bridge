import { UserDAO as KitUserDAO } from '@rexezuge/identity';
import type { D1Queryable } from '@rexezuge/d1';
import { TimestampUtil } from '@rexezuge/shared';

/**
 * Accounts, on the kit's `@rexezuge/identity` DAO.
 *
 * The kit owns the identity columns: `id` is the stable account key, `email`
 * the frozen anchor the legacy `connected_applications.user_email` reference
 * resolves against, and `current_email` the mutable sign-in address. This
 * subclass adds only the two operations this repo needs that the kit does not
 * carry, so every identity read/write runs through one implementation.
 *
 * The schema still differs from the kit's fresh one in exactly the way the
 * kit's own upgrade path leaves a database (migration 0006): `users.email` is
 * the PRIMARY KEY and `id` a unique-indexed column, because the anchor foreign
 * key cannot be repointed without losing rows. Every kit statement works
 * against that shape.
 */
class UserDAO extends KitUserDAO {
  public constructor(database: D1Queryable) {
    super(database);
  }

  /**
   * Heartbeat an existing account.
   *
   * The kit never writes `updated_at` on a resolve, and
   * `deleteInactiveEmptyBefore` reads it -- without this, an account that signs
   * in every day but owns nothing yet would still be reaped as idle.
   */
  public async touch(id: string): Promise<void> {
    await this.run('UPDATE users SET updated_at = ? WHERE id = ?', [TimestampUtil.getCurrentUnixTimestampInSeconds(), id]);
  }

  /**
   * Reap accounts that never became anything: no connected application and no
   * activity since the cutoff. Returns how many rows were deleted.
   *
   * Only account rows with no owner are deleted; an account that owns anything
   * is kept, since `connected_applications` cascades.
   */
  public async deleteInactiveEmptyBefore(cutoff: number, limit: number): Promise<number> {
    const result = await this.run(
      `
        DELETE FROM users
        WHERE id IN (
          SELECT id
          FROM users
          WHERE updated_at < ?
            AND id IS NOT NULL
            AND id NOT IN (
              SELECT user_id FROM connected_applications WHERE user_id IS NOT NULL
            )
          LIMIT ?
        )
      `,
      [cutoff, limit],
    );
    return result.meta?.changes ?? 0;
  }
}

export { UserDAO };
export type { UserRow } from '@rexezuge/identity';
