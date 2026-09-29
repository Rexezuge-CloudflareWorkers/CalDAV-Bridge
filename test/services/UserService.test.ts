import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UserIdentityService } from '@caldav-bridge/backend-services/user';

const { resolveOrCreate } = vi.hoisted(() => ({
  resolveOrCreate: vi.fn(),
}));

// The DAO layer is exercised against a real SQLite engine in `test/dao`, so here
// only the service's own contract is under test.
vi.spyOn(UserIdentityService.prototype, 'resolveOrCreate').mockImplementation(resolveOrCreate);

const IDENTITY = {
  userId: '11111111-1111-4111-8111-111111111111',
  currentEmail: 'user@example.test',
  anchorEmail: 'user@example.test',
};

import { UserService } from '@caldav-bridge/backend-services/user';

describe('UserService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveOrCreate.mockResolvedValue(IDENTITY);
  });

  it('returns the resolved account so callers can authorize against an id', async () => {
    const identity = await new UserService({ DB: {} } as never).upsertUser('user@example.test');

    expect(resolveOrCreate).toHaveBeenCalledWith('user@example.test');
    // The account id is what everything downstream keys on; returning it is what
    // lets an address change keep working.
    expect(identity).toEqual(IDENTITY);
  });

  it("reports the account's current address rather than the one presented", async () => {
    resolveOrCreate.mockResolvedValue({ ...IDENTITY, currentEmail: 'moved@example.test' });

    const user = await new UserService({ DB: {} } as never).getCurrentUser({
      userId: IDENTITY.userId,
      currentEmail: 'moved@example.test',
      anchorEmail: 'user@example.test',
    });

    expect(user.userId).toBe(IDENTITY.userId);
    expect(user.email).toBe('moved@example.test');
    // The frozen anchor is an implementation detail and is not exposed.
    expect(user).not.toHaveProperty('anchorEmail');
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
