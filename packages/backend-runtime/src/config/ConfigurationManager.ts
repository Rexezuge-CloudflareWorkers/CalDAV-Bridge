import {
  DEFAULT_DB_CLEANUP_BATCH_SIZE,
  DEFAULT_DB_CLEANUP_CALDAV_CREDENTIAL_RETENTION_DAYS,
  DEFAULT_DB_CLEANUP_CALENDAR_TOMBSTONE_RETENTION_DAYS,
  DEFAULT_DB_CLEANUP_DRAFT_APPLICATION_RETENTION_DAYS,
  DEFAULT_DB_CLEANUP_EMPTY_USER_RETENTION_DAYS,
  DEFAULT_DB_CLEANUP_OAUTH2_SESSION_RETENTION_DAYS,
  DEFAULT_DEFAULT_CALDAV_CREDENTIAL_EXPIRY_DAYS,
  DEFAULT_MAX_APPLICATIONS_PER_USER,
  DEFAULT_MAX_CALDAV_CREDENTIALS_PER_APPLICATION,
  DEFAULT_MAX_CALDAV_CREDENTIAL_EXPIRY_DAYS,
  DEFAULT_OAUTH2_ACCESS_TOKEN_FALLBACK_TTL_SECONDS,
  DEFAULT_OAUTH2_STATE_EXPIRY_MINUTES,
} from '@caldav-bridge/shared/constants';
import { EnvParser } from './EnvParser';

class ConfigurationManager {
  // ─── Namespace groups ────────────────────────────────────────────────────────

  public static readonly oauth2 = {
    getStateExpiryMinutes: (env: unknown): number => EnvParser.positiveInt(env, 'OAUTH2_STATE_EXPIRY_MINUTES', DEFAULT_OAUTH2_STATE_EXPIRY_MINUTES),
    getAccessTokenFallbackTtlSeconds: (env: unknown): number =>
      EnvParser.positiveInt(env, 'OAUTH2_ACCESS_TOKEN_FALLBACK_TTL_SECONDS', DEFAULT_OAUTH2_ACCESS_TOKEN_FALLBACK_TTL_SECONDS),
  };

  public static readonly limits = {
    getMaxApplicationsPerUser: (env: unknown): number => EnvParser.positiveInt(env, 'MAX_APPLICATIONS_PER_USER', DEFAULT_MAX_APPLICATIONS_PER_USER),
  };

  public static readonly caldav = {
    getMaxCredentialsPerApplication: (env: unknown): number =>
      EnvParser.positiveInt(env, 'MAX_CALDAV_CREDENTIALS_PER_APPLICATION', DEFAULT_MAX_CALDAV_CREDENTIALS_PER_APPLICATION),
    getDefaultCredentialExpiryDays: (env: unknown): number =>
      EnvParser.positiveInt(env, 'DEFAULT_CALDAV_CREDENTIAL_EXPIRY_DAYS', DEFAULT_DEFAULT_CALDAV_CREDENTIAL_EXPIRY_DAYS),
    getMaxCredentialExpiryDays: (env: unknown): number =>
      EnvParser.positiveInt(env, 'MAX_CALDAV_CREDENTIAL_EXPIRY_DAYS', DEFAULT_MAX_CALDAV_CREDENTIAL_EXPIRY_DAYS),
  };

  public static readonly cleanup = {
    getBatchSize: (env: unknown): number => EnvParser.positiveInt(env, 'DB_CLEANUP_BATCH_SIZE', DEFAULT_DB_CLEANUP_BATCH_SIZE),
    getOAuth2SessionRetentionDays: (env: unknown): number =>
      EnvParser.nonNegativeInt(env, 'DB_CLEANUP_OAUTH2_SESSION_RETENTION_DAYS', DEFAULT_DB_CLEANUP_OAUTH2_SESSION_RETENTION_DAYS),
    getCalDavCredentialRetentionDays: (env: unknown): number =>
      EnvParser.nonNegativeInt(env, 'DB_CLEANUP_CALDAV_CREDENTIAL_RETENTION_DAYS', DEFAULT_DB_CLEANUP_CALDAV_CREDENTIAL_RETENTION_DAYS),
    getCalendarTombstoneRetentionDays: (env: unknown): number =>
      EnvParser.nonNegativeInt(env, 'DB_CLEANUP_CALENDAR_TOMBSTONE_RETENTION_DAYS', DEFAULT_DB_CLEANUP_CALENDAR_TOMBSTONE_RETENTION_DAYS),
    getDraftApplicationRetentionDays: (env: unknown): number =>
      EnvParser.nonNegativeInt(env, 'DB_CLEANUP_DRAFT_APPLICATION_RETENTION_DAYS', DEFAULT_DB_CLEANUP_DRAFT_APPLICATION_RETENTION_DAYS),
    getEmptyUserRetentionDays: (env: unknown): number =>
      EnvParser.nonNegativeInt(env, 'DB_CLEANUP_EMPTY_USER_RETENTION_DAYS', DEFAULT_DB_CLEANUP_EMPTY_USER_RETENTION_DAYS),
  };

  // ─── Flat API ────────────────────────────────────────────────────────────────

  public static getMaxApplicationsPerUser(env: unknown): number {
    return this.limits.getMaxApplicationsPerUser(env);
  }
  public static getServeSpaFromWorker(env: unknown): boolean {
    return EnvParser.boolean(env, 'SERVE_SPA_FROM_WORKER', 'false');
  }
  public static getOauth2StateExpiryMinutes(env: unknown): number {
    return this.oauth2.getStateExpiryMinutes(env);
  }
  public static getOAuth2AccessTokenFallbackTtlSeconds(env: unknown): number {
    return this.oauth2.getAccessTokenFallbackTtlSeconds(env);
  }
}

export { ConfigurationManager };
