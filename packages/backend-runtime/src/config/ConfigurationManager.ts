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
  DEFAULT_OAUTH2_ACCESS_TOKEN_MIN_VALID_SECONDS,
  DEFAULT_OAUTH2_STATE_EXPIRY_MINUTES,
} from '@caldav-bridge/shared/constants';
import { EnvParser } from './EnvParser';

class ConfigurationManager {
  // ─── Namespace groups ────────────────────────────────────────────────────────

  public static readonly oauth2 = {
    getStateExpiryMinutes: (env: unknown): number =>
      EnvParser.positiveInt(env, 'OAUTH2_STATE_EXPIRY_MINUTES', DEFAULT_OAUTH2_STATE_EXPIRY_MINUTES),
    getAccessTokenFallbackTtlSeconds: (env: unknown): number =>
      EnvParser.positiveInt(env, 'OAUTH2_ACCESS_TOKEN_FALLBACK_TTL_SECONDS', DEFAULT_OAUTH2_ACCESS_TOKEN_FALLBACK_TTL_SECONDS),
    /**
     * How much life must be left on a token for it to be worth caching.
     *
     * The cached TTL is shortened by this margin, so a token is refreshed
     * *before* it expires rather than after a request has already presented it.
     * It was declared as a variable in `wrangler.template.jsonc` and then
     * hardcoded as `Math.max(60, …)` at both call sites, so changing the deployed
     * configuration had no effect at all.
     */
    getAccessTokenMinValidSeconds: (env: unknown): number =>
      EnvParser.positiveInt(env, 'OAUTH2_ACCESS_TOKEN_MIN_VALID_SECONDS', DEFAULT_OAUTH2_ACCESS_TOKEN_MIN_VALID_SECONDS),
  };

  public static readonly limits = {
    getMaxApplicationsPerUser: (env: unknown): number =>
      EnvParser.positiveInt(env, 'MAX_APPLICATIONS_PER_USER', DEFAULT_MAX_APPLICATIONS_PER_USER),
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

  /**
   * Whether the API worker serves the built SPA itself.
   *
   * Not in a namespace group: it answers "should this route exist at all", which
   * is a question about the deployment rather than about one of the domains
   * above.
   */
  public static getServeSpaFromWorker(env: unknown): boolean {
    return EnvParser.boolean(env, 'SERVE_SPA_FROM_WORKER', 'false');
  }
}

export { ConfigurationManager };
