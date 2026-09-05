import { TimestampUtil } from '@caldav-bridge/shared/utils';
import { CalDavCredentialDAO, CalendarObjectMappingDAO, ConnectedApplicationDAO, OAuth2AuthorizationSessionDAO, UserDAO } from '@caldav-bridge/backend-data/dao';
import type { D1Queryable } from '@caldav-bridge/backend-data/utils';
import { ConfigurationManager } from '@caldav-bridge/backend-runtime/config';
import { IScheduledTask } from './IScheduledTask';
import type { IEnv } from './IScheduledTask';

interface DatabaseCleanupCounts {
  draftApplications: number;
  orphanedApplications: number;
  oauth2AuthorizationSessions: number;
  orphanedOAuth2AuthorizationSessions: number;
  calDavCredentials: number;
  orphanedCalDavCredentials: number;
  calendarObjectMappings: number;
  orphanedCalendarObjectMappings: number;
  oauth2AccessTokenRefreshStatus: number;
  emptyUsers: number;
}

class DatabaseCleanupTask extends IScheduledTask<DatabaseCleanupTaskEnv> {
  protected async handleScheduledTask(_event: ScheduledController, env: DatabaseCleanupTaskEnv, _ctx: ExecutionContext): Promise<void> {
    const counts = await this.cleanup(env);
    const totalDeleted = Object.values(counts).reduce((total, count) => total + count, 0);
    console.log('Database cleanup completed.', { totalDeleted });
  }

  public async cleanup(env: DatabaseCleanupTaskEnv): Promise<DatabaseCleanupCounts> {
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const batchSize = ConfigurationManager.cleanup.getBatchSize(env);
    const applicationDAO = new ConnectedApplicationDAO(env.DB, await env.AES_ENCRYPTION_KEY_SECRET.get());
    const sessionDAO = new OAuth2AuthorizationSessionDAO(env.DB);
    const credentialDAO = new CalDavCredentialDAO(env.DB);
    const mappingDAO = new CalendarObjectMappingDAO(env.DB);
    const userDAO = new UserDAO(env.DB);

    const draftApplicationCutoff = this.cutoff(now, ConfigurationManager.cleanup.getDraftApplicationRetentionDays(env));
    const oauth2SessionCutoff = this.cutoff(now, ConfigurationManager.cleanup.getOAuth2SessionRetentionDays(env));
    const calDavCredentialCutoff = this.cutoff(now, ConfigurationManager.cleanup.getCalDavCredentialRetentionDays(env));
    const tombstoneCutoff = this.cutoff(now, ConfigurationManager.cleanup.getCalendarTombstoneRetentionDays(env));
    const emptyUserCutoff = this.cutoff(now, ConfigurationManager.cleanup.getEmptyUserRetentionDays(env));

    const draftApplications = await applicationDAO.deleteDraftsUpdatedBefore(draftApplicationCutoff, batchSize);
    const orphanedApplications = await applicationDAO.deleteOrphaned(batchSize);
    const orphanedOAuth2AuthorizationSessions = await sessionDAO.deleteOrphaned(batchSize);
    const orphanedCalDavCredentials = await credentialDAO.deleteOrphaned(batchSize);
    const orphanedCalendarObjectMappings = await mappingDAO.deleteOrphaned(batchSize);
    const oauth2AccessTokenRefreshStatus = await this.deleteOrphanedOAuth2AccessTokenRefreshStatus(env.DB, batchSize);
    const oauth2AuthorizationSessions = await sessionDAO.deleteTerminalBefore(oauth2SessionCutoff, batchSize);
    const calDavCredentials = await credentialDAO.deleteExpiredBefore(calDavCredentialCutoff, batchSize);
    const calendarObjectMappings = await mappingDAO.deleteDeletedBefore(tombstoneCutoff, batchSize);
    const emptyUsers = await userDAO.deleteInactiveEmptyBefore(emptyUserCutoff, batchSize);

    return {
      draftApplications,
      orphanedApplications,
      oauth2AuthorizationSessions,
      orphanedOAuth2AuthorizationSessions,
      calDavCredentials,
      orphanedCalDavCredentials,
      calendarObjectMappings,
      orphanedCalendarObjectMappings,
      oauth2AccessTokenRefreshStatus,
      emptyUsers,
    };
  }

  private cutoff(now: number, retentionDays: number): number {
    return now - retentionDays * 86400;
  }

  private async deleteOrphanedOAuth2AccessTokenRefreshStatus(database: D1Queryable, limit: number): Promise<number> {
    const result = await database
      .prepare(
        `
          DELETE FROM oauth2_access_token_refresh_status
          WHERE application_id IN (
            SELECT application_id
            FROM oauth2_access_token_refresh_status
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

interface DatabaseCleanupTaskEnv extends IEnv {
  DB: D1Queryable;
  AES_ENCRYPTION_KEY_SECRET: SecretsStoreSecret;
  DB_CLEANUP_BATCH_SIZE?: string | undefined;
  DB_CLEANUP_OAUTH2_SESSION_RETENTION_DAYS?: string | undefined;
  DB_CLEANUP_CALDAV_CREDENTIAL_RETENTION_DAYS?: string | undefined;
  DB_CLEANUP_CALENDAR_TOMBSTONE_RETENTION_DAYS?: string | undefined;
  DB_CLEANUP_DRAFT_APPLICATION_RETENTION_DAYS?: string | undefined;
  DB_CLEANUP_EMPTY_USER_RETENTION_DAYS?: string | undefined;
}

export { DatabaseCleanupTask };
export type { DatabaseCleanupCounts, DatabaseCleanupTaskEnv };
