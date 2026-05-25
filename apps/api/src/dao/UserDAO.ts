import { TimestampUtil } from '@caldav-bridge/shared/utils';

class UserDAO {
  constructor(private readonly database: D1Database) {}

  public async ensure(email: string): Promise<void> {
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    await this.database
      .prepare(
        `
          INSERT INTO users (email, created_at, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(email) DO UPDATE SET updated_at = excluded.updated_at
        `,
      )
      .bind(email, now, now)
      .run();
  }

  public async deleteInactiveEmptyBefore(cutoff: number, limit: number): Promise<number> {
    const result = await this.database
      .prepare(
        `
          DELETE FROM users
          WHERE email IN (
            SELECT email
            FROM users
            WHERE updated_at < ?
              AND email NOT IN (SELECT user_email FROM connected_applications)
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
