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
}

export { UserDAO };
