import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InternalServerError } from '@caldav-bridge/backend-errors';

const { applicationSpies } = vi.hoisted(() => ({
  applicationSpies: {
    getById: vi.fn(),
    updateOAuth2RefreshToken: vi.fn(),
    markOAuth2Connected: vi.fn(),
  },
}));

vi.mock('@caldav-bridge/backend-data/dao', () => ({
  ConnectedApplicationDAO: class {
    getById = applicationSpies.getById;
    updateOAuth2RefreshToken = applicationSpies.updateOAuth2RefreshToken;
    markOAuth2Connected = applicationSpies.markOAuth2Connected;
  },
}));

import { OAuth2AccessTokenService } from '@caldav-bridge/backend-services/oauth2';

/**
 * A stand-in for the worker's environment, with the KV double typed so the
 * assertions below can inspect it -- an untyped `Record<string, unknown>` would
 * make `env.OAUTH2_TOKEN_CACHE.put` a type error rather than a checkable spy.
 */
function testEnv(
  cached: string | null = null,
): { OAUTH2_TOKEN_CACHE: { get: (key: string) => Promise<string | null>; put: ReturnType<typeof vi.fn> } } & Record<string, unknown> {
  const store = new Map<string, string>(cached ? [['oauth2:app-1', cached]] : []);
  return {
    DB: {},
    AES_ENCRYPTION_KEY_SECRET: { get: async () => 'master-key' },
    OAUTH2_TOKEN_CACHE: {
      get: async (key: string) => store.get(key) ?? null,
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
    },
    OAUTH2_ACCESS_TOKEN_FALLBACK_TTL_SECONDS: '3600',
  };
}

function application(): Record<string, unknown> {
  return {
    applicationId: 'app-1',
    providerId: 'google-calendar',
    credentials: { clientId: 'client-id', clientSecret: 'client-secret', refreshToken: 'refresh-token' },
  };
}

function tokenResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('OAuth2AccessTokenService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns cached access tokens without refreshing', async () => {
    const accessToken = await OAuth2AccessTokenService.getAccessToken('app-1', testEnv('cached-token') as never);

    expect(accessToken).toBe('cached-token');
    expect(applicationSpies.getById).not.toHaveBeenCalled();
  });

  it('refreshes expired tokens and rotates refresh tokens', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse({ access_token: 'new-token', refresh_token: 'rotated', expires_in: 3600 }));
    vi.stubGlobal('fetch', fetchMock);
    applicationSpies.getById.mockResolvedValue(application());
    applicationSpies.updateOAuth2RefreshToken.mockResolvedValue(undefined);
    const env = testEnv();

    const accessToken = await OAuth2AccessTokenService.getAccessToken('app-1', env as never);

    expect(accessToken).toBe('new-token');
    expect(applicationSpies.updateOAuth2RefreshToken).toHaveBeenCalledWith('app-1', 'rotated');
    expect(env.OAUTH2_TOKEN_CACHE.put).toHaveBeenCalledWith('oauth2:app-1', 'new-token', { expirationTtl: 3540 });
  });

  it('rejects unknown applications', async () => {
    applicationSpies.getById.mockResolvedValue(undefined);

    await expect(OAuth2AccessTokenService.refreshAccessToken('missing', testEnv() as never)).rejects.toBeInstanceOf(InternalServerError);
  });

  it('completes authorization codes and connects applications', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse({ access_token: 'fresh-token', refresh_token: 'fresh-refresh', expires_in: 1800 }))
      .mockResolvedValueOnce(tokenResponse({ email: 'user@example.test' }));
    vi.stubGlobal('fetch', fetchMock);
    applicationSpies.getById.mockResolvedValue(application());
    applicationSpies.markOAuth2Connected.mockResolvedValue(undefined);
    const env = testEnv();

    await OAuth2AccessTokenService.completeAuthorization('app-1', 'https://bridge.example.test/cb', 'code', 'verifier', env as never);

    expect(applicationSpies.markOAuth2Connected).toHaveBeenCalledWith('app-1', 'fresh-refresh', 'user@example.test');
    expect(env.OAUTH2_TOKEN_CACHE.put).toHaveBeenCalledWith('oauth2:app-1', 'fresh-token', { expirationTtl: 1740 });
  });

  /**
   * The cached TTL is the provider's lifetime minus a margin, so a token is
   * refreshed before it expires rather than after a request has already presented
   * it. The margin was hardcoded as `Math.max(60, …)` at both call sites while
   * `OAUTH2_ACCESS_TOKEN_MIN_VALID_SECONDS` sat unread in the wrangler template.
   */
  it('shortens the cached lifetime by the configured margin', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(tokenResponse({ access_token: 'new-token', expires_in: 3600 })));
    applicationSpies.getById.mockResolvedValue(application());
    applicationSpies.updateOAuth2RefreshToken.mockResolvedValue(undefined);
    const env = testEnv();

    await OAuth2AccessTokenService.refreshAccessToken('app-1', { ...env, OAUTH2_ACCESS_TOKEN_MIN_VALID_SECONDS: '300' } as never);

    // 3600 from the provider, less the 300-second margin.
    expect(env.OAUTH2_TOKEN_CACHE.put).toHaveBeenCalledWith('oauth2:app-1', 'new-token', { expirationTtl: 3300 });
  });

  it('caches for the margin itself when the provider reports a very short lifetime', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(tokenResponse({ access_token: 'new-token', expires_in: 30 })));
    applicationSpies.getById.mockResolvedValue(application());
    applicationSpies.updateOAuth2RefreshToken.mockResolvedValue(undefined);
    const env = testEnv();

    await OAuth2AccessTokenService.refreshAccessToken('app-1', { ...env, OAUTH2_ACCESS_TOKEN_MIN_VALID_SECONDS: '60' } as never);

    // A token already inside its own margin is still cached, for exactly the
    // margin. Caching it for less would mean a refresh on every request.
    expect(env.OAUTH2_TOKEN_CACHE.put).toHaveBeenCalledWith('oauth2:app-1', 'new-token', { expirationTtl: 60 });
  });
});
