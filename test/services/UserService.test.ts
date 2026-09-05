import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ensure } = vi.hoisted(() => ({
  ensure: vi.fn(),
}));

vi.mock('@caldav-bridge/backend-data/dao', () => ({
  UserDAO: class {
    ensure = ensure;
  },
}));

import { UserService } from '@caldav-bridge/backend-services/user';

describe('UserService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('upserts users by email', async () => {
    ensure.mockResolvedValue(undefined);

    await new UserService({ DB: {} } as never).upsertUser('user@example.test');

    expect(ensure).toHaveBeenCalledWith('user@example.test');
  });

  it('reports configured limits with package defaults', async () => {
    const limits = await new UserService({ DB: {} } as never).getCurrentUserLimits();

    expect(limits).toEqual({
      maxApplicationsPerUser: 99,
      maxCalDavCredentialsPerApplication: 5,
      defaultCalDavCredentialExpiryDays: 365,
    });

    const custom = await new UserService({
      DB: {},
      MAX_APPLICATIONS_PER_USER: '3',
      MAX_CALDAV_CREDENTIALS_PER_APPLICATION: '2',
      DEFAULT_CALDAV_CREDENTIAL_EXPIRY_DAYS: '30',
    } as never).getCurrentUserLimits();

    expect(custom).toEqual({
      maxApplicationsPerUser: 3,
      maxCalDavCredentialsPerApplication: 2,
      defaultCalDavCredentialExpiryDays: 30,
    });
  });
});
