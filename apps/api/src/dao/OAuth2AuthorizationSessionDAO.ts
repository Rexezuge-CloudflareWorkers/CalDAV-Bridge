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
}

export { OAuth2AuthorizationSessionDAO };
