import type { OAuth2AuthorizationSession, OAuth2AuthorizationSessionInternal } from '@caldav-bridge/shared/model';
import { TimestampUtil, UUIDUtil } from '@caldav-bridge/shared/utils';

class OAuth2AuthorizationSessionDAO {
  constructor(private readonly database: D1Database) {}

  public async create(applicationId: string, stateHash: string, codeVerifier: string, redirectUri: string, expiresAt: number): Promise<void> {
    await this.database
      .prepare(
        `
          INSERT INTO oauth2_authorization_sessions
            (session_id, application_id, state_hash, code_verifier, redirect_uri, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .bind(UUIDUtil.getRandomUUID(), applicationId, stateHash, codeVerifier, redirectUri, TimestampUtil.getCurrentUnixTimestampInSeconds(), expiresAt)
      .run();
  }

  public async getActive(applicationId: string, stateHash: string): Promise<OAuth2AuthorizationSession | undefined> {
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const row = await this.database
      .prepare(
        `
          SELECT session_id, application_id, state_hash, code_verifier, redirect_uri, created_at, expires_at, consumed_at
          FROM oauth2_authorization_sessions
          WHERE application_id = ? AND state_hash = ? AND expires_at > ? AND consumed_at IS NULL
          LIMIT 1
        `,
      )
      .bind(applicationId, stateHash, now)
      .first<OAuth2AuthorizationSessionInternal>();
    return row
      ? {
          sessionId: row.session_id,
          applicationId: row.application_id,
          stateHash: row.state_hash,
          codeVerifier: row.code_verifier,
          redirectUri: row.redirect_uri,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          consumedAt: row.consumed_at,
        }
      : undefined;
  }

  public async consume(sessionId: string): Promise<void> {
    await this.database
      .prepare('UPDATE oauth2_authorization_sessions SET consumed_at = ? WHERE session_id = ?')
      .bind(TimestampUtil.getCurrentUnixTimestampInSeconds(), sessionId)
      .run();
  }

  public async deleteTerminalBefore(cutoff: number, limit: number): Promise<number> {
    const result = await this.database
      .prepare(
        `
          DELETE FROM oauth2_authorization_sessions
          WHERE session_id IN (
            SELECT session_id
            FROM oauth2_authorization_sessions
            WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)
            LIMIT ?
          )
        `,
      )
      .bind(cutoff, cutoff, limit)
      .run();
    return result.meta?.changes ?? 0;
  }

  public async deleteOrphaned(limit: number): Promise<number> {
    const result = await this.database
      .prepare(
        `
          DELETE FROM oauth2_authorization_sessions
          WHERE session_id IN (
            SELECT session_id
            FROM oauth2_authorization_sessions
            WHERE application_id NOT IN (SELECT application_id FROM connected_applications)
            LIMIT ?
          )
        `,
      )
      .bind(limit)
      .run();
    return result.meta?.changes ?? 0;
  }
}

export { OAuth2AuthorizationSessionDAO };
