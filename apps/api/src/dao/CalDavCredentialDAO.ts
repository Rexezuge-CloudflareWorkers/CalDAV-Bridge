import type { CalDavCredentialInternal, CalDavCredentialMetadata } from '@caldav-bridge/shared/model';
import { TimestampUtil, UUIDUtil } from '@caldav-bridge/shared/utils';

class CalDavCredentialDAO {
  constructor(private readonly database: D1Database) {}

  public async create(
    applicationId: string,
    passwordHash: string,
    name: string,
    passwordPrefix: string,
    passwordLastFour: string,
    expiresAt: number,
  ): Promise<CalDavCredentialMetadata> {
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const credentialId = UUIDUtil.getRandomUUID();
    await this.database
      .prepare(
        `
          INSERT INTO caldav_credentials
            (credential_id, application_id, password_hash, name, password_prefix, password_last_four, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .bind(credentialId, applicationId, passwordHash, name, passwordPrefix, passwordLastFour, now, expiresAt)
      .run();
    const credential = await this.getById(credentialId);
    if (!credential) throw new Error('Failed to load CalDAV credential after create.');
    return credential;
  }

  public async getByHash(passwordHash: string, activeOnly: boolean): Promise<CalDavCredentialMetadata | undefined> {
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const activeFilter = activeOnly ? ' AND expires_at > ?' : '';
    const bindings: unknown[] = activeOnly ? [passwordHash, now] : [passwordHash];
    const row = await this.database
      .prepare(
        `
          SELECT credential_id, application_id, password_hash, name, password_prefix, password_last_four, created_at, expires_at, last_used_at
          FROM caldav_credentials
          WHERE password_hash = ?${activeFilter}
          LIMIT 1
        `,
      )
      .bind(...bindings)
      .first<CalDavCredentialInternal>();
    return row ? this.toMetadata(row) : undefined;
  }

  public async getById(credentialId: string): Promise<CalDavCredentialMetadata | undefined> {
    const row = await this.database
      .prepare(
        `
          SELECT credential_id, application_id, password_hash, name, password_prefix, password_last_four, created_at, expires_at, last_used_at
          FROM caldav_credentials
          WHERE credential_id = ?
          LIMIT 1
        `,
      )
      .bind(credentialId)
      .first<CalDavCredentialInternal>();
    return row ? this.toMetadata(row) : undefined;
  }

  public async listByApplication(applicationId: string): Promise<CalDavCredentialMetadata[]> {
    const rows = await this.database
      .prepare(
        `
          SELECT credential_id, application_id, password_hash, name, password_prefix, password_last_four, created_at, expires_at, last_used_at
          FROM caldav_credentials
          WHERE application_id = ?
          ORDER BY created_at DESC
        `,
      )
      .bind(applicationId)
      .all<CalDavCredentialInternal>()
      .then((result) => result.results || []);
    return rows.map((row) => this.toMetadata(row));
  }

  public async countByApplication(applicationId: string): Promise<number> {
    const row = await this.database.prepare('SELECT COUNT(*) AS count FROM caldav_credentials WHERE application_id = ?').bind(applicationId).first<{ count: number }>();
    return row?.count ?? 0;
  }

  public async updateLastUsed(credentialId: string): Promise<void> {
    await this.database
      .prepare('UPDATE caldav_credentials SET last_used_at = ? WHERE credential_id = ?')
      .bind(TimestampUtil.getCurrentUnixTimestampInSeconds(), credentialId)
      .run();
  }

  public async deleteForApplication(credentialId: string, applicationId: string): Promise<void> {
    await this.database.prepare('DELETE FROM caldav_credentials WHERE credential_id = ? AND application_id = ?').bind(credentialId, applicationId).run();
  }

  private toMetadata(row: CalDavCredentialInternal): CalDavCredentialMetadata {
    return {
      credentialId: row.credential_id,
      applicationId: row.application_id,
      name: row.name,
      passwordPrefix: row.password_prefix,
      passwordLastFour: row.password_last_four,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
    };
  }
}

export { CalDavCredentialDAO };
