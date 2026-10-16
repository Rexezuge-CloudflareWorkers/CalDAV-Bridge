import { describe, expect, it, vi } from 'vitest';
import { AccessAuthError } from '@rexezuge/http';
import { InternalServerError, UnauthorizedError } from '@rexezuge/errors';

const { authenticateAccess, upsertUser } = vi.hoisted(() => ({
  authenticateAccess: vi.fn(),
  upsertUser: vi.fn(),
}));

const ACCOUNT = {
  id: 'usr_11111111111141118111111111111111',
  email: 'user@example.test',
  anchorEmail: 'user@example.test',
  username: null,
};

// The kit's `authenticateAccess` is the whole of the Access path now; the repo
// wiring under test is what it is called with and how its refusal is mapped.
// Partially mocked so the test can build the real `AccessAuthError` the kit
// throws — a `ServiceError` now, so the middleware maps it through the same
// client-error path as everything else.
vi.mock('@rexezuge/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@rexezuge/http')>()),
  authenticateAccess,
}));

vi.mock('@caldav-bridge/backend-services/user', () => ({
  UserService: class {
    upsertUser = upsertUser;
  },
}));

import { MiddlewareHandlers } from '@/middleware';

const TEAM_DOMAIN = 'https://team.example.test';

describe('MiddlewareHandlers', () => {
  it('authenticates users, resolves them to an account, and continues', async () => {
    authenticateAccess.mockResolvedValue('user@example.test');
    upsertUser.mockResolvedValue(ACCOUNT);
    const set = vi.fn();
    const next = vi.fn();
    const context = fakeContext(set);

    await MiddlewareHandlers.userAuthentication()(context, next);

    expect(authenticateAccess).toHaveBeenCalledOnce();
    expect(upsertUser).toHaveBeenCalledWith('user@example.test');
    // The resolved account is what handlers read: the id to authorize against
    // and the address to display, neither taken from the raw request.
    expect(set).toHaveBeenCalledWith('AuthenticatedUser', ACCOUNT);
    expect(next).toHaveBeenCalledOnce();
  });

  it("exposes the account's current address, not the one presented", async () => {
    // The user changed their address, so the old one still authenticates them
    // through Cloudflare Access but must not be what the UI reports.
    authenticateAccess.mockResolvedValue('moved@example.test');
    upsertUser.mockResolvedValue({ ...ACCOUNT, email: 'moved@example.test' });
    const set = vi.fn();

    await MiddlewareHandlers.userAuthentication()(fakeContext(set), vi.fn());

    expect(set).toHaveBeenCalledWith('AuthenticatedUser', { ...ACCOUNT, email: 'moved@example.test' });
  });

  it('hands the Access configuration from the environment to the kit', async () => {
    authenticateAccess.mockResolvedValue('user@example.test');
    upsertUser.mockResolvedValue(ACCOUNT);
    const context = fakeContext(vi.fn(), {
      DEV_AUTH_EMAIL: 'dev@example.test',
      TEAM_DOMAIN: 'https://team.example.test/',
      POLICY_AUD: 'audience-aud',
    });

    await MiddlewareHandlers.userAuthentication()(context, vi.fn());

    // The team domain is passed through unnormalized: the kit owns trailing-slash
    // normalization, and a second implementation of it here could disagree.
    expect(authenticateAccess).toHaveBeenCalledWith(expect.any(Request), undefined, {
      bypassAllowed: true,
      devAuthEmail: 'dev@example.test',
      teamDomain: 'https://team.example.test/',
      policyAud: 'audience-aud',
    });
  });

  it('maps a refused Access identity to a 401 JSON error', async () => {
    // The kit's `AccessAuthError` extends `UnauthorizedError`, so it is a
    // `ServiceError` and needs no translation at this boundary.
    authenticateAccess.mockRejectedValue(new AccessAuthError('Cloudflare Access authentication failed.'));
    const next = vi.fn();

    const response = (await MiddlewareHandlers.userAuthentication()(fakeContext(vi.fn()), next)) as Response;

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Cloudflare Access authentication failed.' });
  });

  it('maps other client authentication failures to JSON errors', async () => {
    authenticateAccess.mockRejectedValue(new UnauthorizedError('No token.'));
    const next = vi.fn();

    const response = (await MiddlewareHandlers.userAuthentication()(fakeContext(vi.fn()), next)) as Response;

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'No token.' });
  });

  it('rethrows errors that are not ServiceErrors', async () => {
    // Only the kit's taxonomy maps to JSON here; anything else is a bug or an
    // infrastructure failure and must surface as one.
    authenticateAccess.mockRejectedValue(new Error('boom'));

    await expect(MiddlewareHandlers.userAuthentication()(fakeContext(vi.fn()), vi.fn())).rejects.toThrow('boom');
  });

  it('rethrows server failures instead of mapping them', async () => {
    authenticateAccess.mockRejectedValue(new InternalServerError('DB down.'));

    await expect(MiddlewareHandlers.userAuthentication()(fakeContext(vi.fn()), vi.fn())).rejects.toThrow('DB down.');
  });
});

type UserHandler = ReturnType<typeof MiddlewareHandlers.userAuthentication>;
type UserHandlerContext = Parameters<UserHandler>[0];

function fakeContext(set: ReturnType<typeof vi.fn>, env: Record<string, string> = {}): UserHandlerContext {
  return {
    req: { raw: new Request('https://bridge.example.test/user/me') },
    env: { TEAM_DOMAIN, ...env },
    set,
    json: (value: unknown, status: number) => Response.json(value, { status }),
  } as unknown as UserHandlerContext;
}
