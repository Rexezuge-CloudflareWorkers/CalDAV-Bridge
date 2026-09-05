import { describe, expect, it, vi } from 'vitest';
import { InternalServerError, UnauthorizedError } from '@caldav-bridge/backend-errors';

const { getAuthenticatedUserEmail, upsertUser } = vi.hoisted(() => ({
  getAuthenticatedUserEmail: vi.fn(),
  upsertUser: vi.fn(),
}));

vi.mock('@caldav-bridge/backend-services/auth', () => ({
  EmailValidationUtil: { getAuthenticatedUserEmail },
}));

vi.mock('@caldav-bridge/backend-services/user', () => ({
  UserService: class {
    upsertUser = upsertUser;
  },
}));

import { MiddlewareHandlers } from '@/middleware';

describe('MiddlewareHandlers', () => {
  it('authenticates users, upserts them, and continues', async () => {
    getAuthenticatedUserEmail.mockResolvedValue('user@example.test');
    upsertUser.mockResolvedValue(undefined);
    const set = vi.fn();
    const next = vi.fn();
    const context = fakeContext(set);

    await MiddlewareHandlers.userAuthentication()(context, next);

    expect(getAuthenticatedUserEmail).toHaveBeenCalledOnce();
    expect(upsertUser).toHaveBeenCalledWith('user@example.test');
    expect(set).toHaveBeenCalledWith('AuthenticatedUserEmailAddress', 'user@example.test');
    expect(next).toHaveBeenCalledOnce();
  });

  it('maps client authentication failures to JSON errors', async () => {
    getAuthenticatedUserEmail.mockRejectedValue(new UnauthorizedError('No token.'));
    const next = vi.fn();

    const response = (await MiddlewareHandlers.userAuthentication()(fakeContext(vi.fn()), next)) as Response;

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'No token.' });
  });

  it('rethrows server failures instead of mapping them', async () => {
    getAuthenticatedUserEmail.mockRejectedValue(new InternalServerError('DB down.'));

    await expect(MiddlewareHandlers.userAuthentication()(fakeContext(vi.fn()), vi.fn())).rejects.toThrow('DB down.');
  });
});

type UserHandler = ReturnType<typeof MiddlewareHandlers.userAuthentication>;
type UserHandlerContext = Parameters<UserHandler>[0];

function fakeContext(set: ReturnType<typeof vi.fn>): UserHandlerContext {
  return {
    req: { raw: new Request('https://bridge.example.test/user/me') },
    env: {},
    set,
    json: (value: unknown, status: number) => Response.json(value, { status }),
  } as unknown as UserHandlerContext;
}
