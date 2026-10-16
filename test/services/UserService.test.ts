import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveOrRegister, touch } = vi.hoisted(() => ({
  resolveOrRegister: vi.fn(),
  touch: vi.fn(),
}));

// What is under test here is the wiring: the kit's resolver plus the repo's
// heartbeat. The resolution itself is covered against a real schema in
// `test/services/UserIdentity.test.ts`, and the heartbeat in
// `test/dao/UserDAO.test.ts`.
vi.mock('@rexezuge/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@rexezuge/identity')>()),
  UserIdentityService: class {
    public resolveOrRegister = resolveOrRegister;
  },
}));

vi.mock('@caldav-bridge/backend-data/dao', () => ({
  UserDAO: class {
    public touch = touch;
  },
}));

import { UserService } from '@caldav-bridge/backend-services/user';

const ACCOUNT = {
  id: 'usr_11111111111141118111111111111111',
  email: 'user@example.test',
  anchorEmail: 'user@example.test',
  username: null,
};

describe('UserService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveOrRegister.mockResolvedValue(ACCOUNT);
  });

  it('returns the resolved account so callers can authorize against an id', async () => {
    const account = await new UserService({ DB: {} } as never).upsertUser('user@example.test');

    expect(resolveOrRegister).toHaveBeenCalledWith('user@example.test');
    // The account id is what everything downstream keys on; returning it is what
    // lets an address change keep working.
    expect(account).toEqual(ACCOUNT);
  });

  it('heartbeats the account, so the retention sweep can see it is alive', async () => {
    await new UserService({ DB: {} } as never).upsertUser('user@example.test');

    expect(touch).toHaveBeenCalledWith(ACCOUNT.id);
  });

  it('fails loudly when the address cannot be resolved to an account', async () => {
    resolveOrRegister.mockResolvedValue(null);

    // A registry row that points at a missing account resolves to nothing;
    // answering with an identity that owns nothing would look like a
    // successful sign-in that never works.
    await expect(new UserService({ DB: {} } as never).upsertUser('user@example.test')).rejects.toThrow(/Failed to provision/);
  });

  it("reports the account's current address rather than the one presented", async () => {
    const user = await new UserService({ DB: {} } as never).getCurrentUser({
      ...ACCOUNT,
      email: 'moved@example.test',
    });

    expect(user.userId).toBe(ACCOUNT.id);
    expect(user.email).toBe('moved@example.test');
    // The frozen anchor and the handle are implementation details and are not
    // exposed.
    expect(user).not.toHaveProperty('anchorEmail');
    expect(user).not.toHaveProperty('username');
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
