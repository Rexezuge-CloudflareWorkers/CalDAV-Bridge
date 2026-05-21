import {
  CONNECTED_APPLICATION_STATUS_CONNECTED,
  CONNECTED_APPLICATION_STATUS_DRAFT,
  CONNECTED_APPLICATION_STATUS_ERROR,
  CONNECTION_METHOD_OAUTH2,
} from '@caldav-bridge/shared/constants';
import type {
  ConnectedApplication,
  ConnectedApplicationCredentials,
  ConnectedApplicationInternal,
  ConnectedApplicationMetadata,
  OAuth2Credentials,
} from '@caldav-bridge/shared/model';
import { TimestampUtil, UUIDUtil } from '@caldav-bridge/shared/utils';
import { decryptData, encryptData } from '@/crypto';

class ConnectedApplicationDAO {
  constructor(
    private readonly database: D1Database,
    private readonly masterKey: string,
  ) {}

  public async create(
    userEmail: string,
    displayName: string,
    providerId: string,
    credentials: ConnectedApplicationCredentials,
  ): Promise<ConnectedApplicationMetadata> {
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const applicationId = UUIDUtil.getRandomUUID();
    const encrypted = await encryptData(JSON.stringify(credentials), this.masterKey);
    await this.database
      .prepare(
        `
          INSERT INTO connected_applications
            (application_id, user_email, provider_email, display_name, provider_id, connection_method, encrypted_credentials, credentials_iv, status, last_error, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .bind(
        applicationId,
        userEmail,
        null,
        displayName,
        providerId,
        CONNECTION_METHOD_OAUTH2,
        encrypted.encrypted,
        encrypted.iv,
        CONNECTED_APPLICATION_STATUS_DRAFT,
        null,
        now,
        now,
      )
      .run();
    const application = await this.getMetadataByIdForUser(applicationId, userEmail);
    if (!application) throw new Error('Failed to load connected application after create.');
    return application;
  }

  public async updateForUser(
    applicationId: string,
    userEmail: string,
    displayName: string,
    credentials: ConnectedApplicationCredentials,
  ): Promise<ConnectedApplicationMetadata | undefined> {
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const existing = await this.getByIdForUser(applicationId, userEmail);
    if (!existing) return undefined;
    const encrypted = await encryptData(JSON.stringify({ ...credentials, refreshToken: existing.credentials.refreshToken }), this.masterKey);
    await this.database
      .prepare(
        `
          UPDATE connected_applications
          SET display_name = ?, encrypted_credentials = ?, credentials_iv = ?, updated_at = ?
          WHERE application_id = ? AND user_email = ?
        `,
      )
      .bind(displayName, encrypted.encrypted, encrypted.iv, now, applicationId, userEmail)
      .run();
    return this.getMetadataByIdForUser(applicationId, userEmail);
  }

  public async listMetadataByUserEmail(userEmail: string): Promise<ConnectedApplicationMetadata[]> {
    const rows = await this.database
      .prepare(
        `
          SELECT application_id, user_email, provider_email, display_name, provider_id, connection_method, encrypted_credentials, credentials_iv, status, last_error, created_at, updated_at
          FROM connected_applications
          WHERE user_email = ?
          ORDER BY updated_at DESC, created_at DESC
        `,
      )
      .bind(userEmail)
      .all<ConnectedApplicationInternal>()
      .then((result) => result.results || []);
    return rows.map((row) => this.toMetadata(row));
  }

  public async countByUserEmail(userEmail: string): Promise<number> {
    const row = await this.database.prepare('SELECT COUNT(*) AS count FROM connected_applications WHERE user_email = ?').bind(userEmail).first<{ count: number }>();
    return row?.count ?? 0;
  }

  public async getMetadataByIdForUser(applicationId: string, userEmail: string): Promise<ConnectedApplicationMetadata | undefined> {
    const row = await this.getRowById(applicationId, userEmail);
    return row ? this.toMetadata(row) : undefined;
  }

  public async getById(applicationId: string): Promise<ConnectedApplication | undefined> {
    const row = await this.getRowById(applicationId);
    return row ? this.toApplication(row) : undefined;
  }

  public async getByIdForUser(applicationId: string, userEmail: string): Promise<ConnectedApplication | undefined> {
    const row = await this.getRowById(applicationId, userEmail);
    return row ? this.toApplication(row) : undefined;
  }

  public async markOAuth2Connected(applicationId: string, refreshToken: string, providerEmail: string): Promise<void> {
    const application = await this.getById(applicationId);
    if (!application) throw new Error('OAuth2 application was not found.');
    const credentials: OAuth2Credentials = { ...application.credentials, refreshToken };
    const encrypted = await encryptData(JSON.stringify(credentials), this.masterKey);
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    await this.database
      .prepare(
        `
          UPDATE connected_applications
          SET encrypted_credentials = ?, credentials_iv = ?, provider_email = ?, status = ?, last_error = NULL, updated_at = ?
          WHERE application_id = ?
        `,
      )
      .bind(encrypted.encrypted, encrypted.iv, providerEmail, CONNECTED_APPLICATION_STATUS_CONNECTED, now, applicationId)
      .run();
  }

  public async updateOAuth2RefreshToken(applicationId: string, refreshToken: string): Promise<void> {
    const application = await this.getById(applicationId);
    if (!application) return;
    const encrypted = await encryptData(JSON.stringify({ ...application.credentials, refreshToken }), this.masterKey);
    await this.database
      .prepare('UPDATE connected_applications SET encrypted_credentials = ?, credentials_iv = ? WHERE application_id = ?')
      .bind(encrypted.encrypted, encrypted.iv, applicationId)
      .run();
  }

  public async deleteForUser(applicationId: string, userEmail: string): Promise<void> {
    await this.database.prepare('DELETE FROM connected_applications WHERE application_id = ? AND user_email = ?').bind(applicationId, userEmail).run();
  }

  private async getRowById(applicationId: string, userEmail?: string): Promise<ConnectedApplicationInternal | undefined> {
    const whereUser = userEmail ? ' AND user_email = ?' : '';
    const bindings = userEmail ? [applicationId, userEmail] : [applicationId];
    const row = await this.database
      .prepare(
        `
          SELECT application_id, user_email, provider_email, display_name, provider_id, connection_method, encrypted_credentials, credentials_iv, status, last_error, created_at, updated_at
          FROM connected_applications
          WHERE application_id = ?${whereUser}
          LIMIT 1
        `,
      )
      .bind(...bindings)
      .first<ConnectedApplicationInternal>();
    return row ?? undefined;
  }

  private async toApplication(row: ConnectedApplicationInternal): Promise<ConnectedApplication> {
    const decryptedCredentials = await decryptData(row.encrypted_credentials, row.credentials_iv, this.masterKey);
    return { ...this.toMetadata(row), credentials: JSON.parse(decryptedCredentials) as ConnectedApplicationCredentials };
  }

  private toMetadata(row: ConnectedApplicationInternal): ConnectedApplicationMetadata {
    return {
      applicationId: row.application_id,
      userEmail: row.user_email,
      providerEmail: row.provider_email,
      displayName: row.display_name,
      providerId: row.provider_id,
      connectionMethod: row.connection_method,
      status:
        row.status === CONNECTED_APPLICATION_STATUS_CONNECTED
          ? CONNECTED_APPLICATION_STATUS_CONNECTED
          : row.status === CONNECTED_APPLICATION_STATUS_ERROR
            ? CONNECTED_APPLICATION_STATUS_ERROR
            : CONNECTED_APPLICATION_STATUS_DRAFT,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export { ConnectedApplicationDAO };
