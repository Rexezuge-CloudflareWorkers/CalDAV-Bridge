import { beforeEach, describe, expect, it, vi } from 'vitest';

const { daoSpies } = vi.hoisted(() => ({
  daoSpies: {
    deleteDraftsUpdatedBefore: vi.fn(),
    deleteOrphanedApplications: vi.fn(),
    deleteTerminalBefore: vi.fn(),
    deleteOrphanedSessions: vi.fn(),
    deleteExpiredBefore: vi.fn(),
    deleteOrphanedCredentials: vi.fn(),
    deleteDeletedBefore: vi.fn(),
    deleteOrphanedMappings: vi.fn(),
    deleteInactiveEmptyBefore: vi.fn(),
  },
}));

vi.mock('@caldav-bridge/shared/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@caldav-bridge/shared/utils')>()),
  TimestampUtil: {
    getCurrentUnixTimestampInSeconds: () => 1_000_000,
  },
}));

vi.mock('@/dao', () => ({
  ConnectedApplicationDAO: class {
    deleteDraftsUpdatedBefore = daoSpies.deleteDraftsUpdatedBefore;
    deleteOrphaned = daoSpies.deleteOrphanedApplications;
  },
  OAuth2AuthorizationSessionDAO: class {
    deleteTerminalBefore = daoSpies.deleteTerminalBefore;
    deleteOrphaned = daoSpies.deleteOrphanedSessions;
  },
  CalDavCredentialDAO: class {
    deleteExpiredBefore = daoSpies.deleteExpiredBefore;
    deleteOrphaned = daoSpies.deleteOrphanedCredentials;
  },
  CalendarObjectMappingDAO: class {
    deleteDeletedBefore = daoSpies.deleteDeletedBefore;
    deleteOrphaned = daoSpies.deleteOrphanedMappings;
  },
  UserDAO: class {
    deleteInactiveEmptyBefore = daoSpies.deleteInactiveEmptyBefore;
  },
}));

import { DatabaseCleanupTask } from '@/scheduled/DatabaseCleanupTask';

describe('DatabaseCleanupTask', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    for (const spy of Object.values(daoSpies)) spy.mockReset();
    daoSpies.deleteDraftsUpdatedBefore.mockResolvedValue(1);
    daoSpies.deleteOrphanedApplications.mockResolvedValue(2);
    daoSpies.deleteOrphanedSessions.mockResolvedValue(3);
    daoSpies.deleteOrphanedCredentials.mockResolvedValue(4);
    daoSpies.deleteOrphanedMappings.mockResolvedValue(5);
    daoSpies.deleteTerminalBefore.mockResolvedValue(6);
    daoSpies.deleteExpiredBefore.mockResolvedValue(7);
    daoSpies.deleteDeletedBefore.mockResolvedValue(8);
    daoSpies.deleteInactiveEmptyBefore.mockResolvedValue(9);
  });

  it('deletes each cleanup category with configured retention cutoffs and batch size', async () => {
    const refreshStatusDelete = vi.fn().mockResolvedValue({ meta: { changes: 10 } });
    const env = {
      DB: fakeDatabase(refreshStatusDelete),
      AES_ENCRYPTION_KEY_SECRET: { get: vi.fn().mockResolvedValue('master-key') },
      DB_CLEANUP_BATCH_SIZE: '25',
      DB_CLEANUP_OAUTH2_SESSION_RETENTION_DAYS: '2',
      DB_CLEANUP_CALDAV_CREDENTIAL_RETENTION_DAYS: '3',
      DB_CLEANUP_CALENDAR_TOMBSTONE_RETENTION_DAYS: '4',
      DB_CLEANUP_DRAFT_APPLICATION_RETENTION_DAYS: '5',
      DB_CLEANUP_EMPTY_USER_RETENTION_DAYS: '6',
    } as unknown as Env;

    const counts = await new DatabaseCleanupTask().cleanup(env);

    expect(daoSpies.deleteDraftsUpdatedBefore).toHaveBeenCalledWith(1_000_000 - 5 * 86400, 25);
    expect(daoSpies.deleteTerminalBefore).toHaveBeenCalledWith(1_000_000 - 2 * 86400, 25);
    expect(daoSpies.deleteExpiredBefore).toHaveBeenCalledWith(1_000_000 - 3 * 86400, 25);
    expect(daoSpies.deleteDeletedBefore).toHaveBeenCalledWith(1_000_000 - 4 * 86400, 25);
    expect(daoSpies.deleteInactiveEmptyBefore).toHaveBeenCalledWith(1_000_000 - 6 * 86400, 25);
    expect(daoSpies.deleteOrphanedApplications).toHaveBeenCalledWith(25);
    expect(daoSpies.deleteOrphanedSessions).toHaveBeenCalledWith(25);
    expect(daoSpies.deleteOrphanedCredentials).toHaveBeenCalledWith(25);
    expect(daoSpies.deleteOrphanedMappings).toHaveBeenCalledWith(25);
    expect(refreshStatusDelete).toHaveBeenCalledWith(25);
    expect(counts).toEqual({
      draftApplications: 1,
      orphanedApplications: 2,
      orphanedOAuth2AuthorizationSessions: 3,
      orphanedCalDavCredentials: 4,
      orphanedCalendarObjectMappings: 5,
      oauth2AuthorizationSessions: 6,
      calDavCredentials: 7,
      calendarObjectMappings: 8,
      emptyUsers: 9,
      oauth2AccessTokenRefreshStatus: 10,
    });
  });
});

function fakeDatabase(run: ReturnType<typeof vi.fn>): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn((limit: number) => ({
        run: () => run(limit),
      })),
    })),
  } as unknown as D1Database;
}
