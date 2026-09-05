import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestError } from '@caldav-bridge/backend-errors';

const { sessionSpies, tokenSpies } = vi.hoisted(() => ({
  sessionSpies: {
    create: vi.fn(),
    getActive: vi.fn(),
    consume: vi.fn(),
  },
  tokenSpies: {
    completeAuthorization: vi.fn(),
  },
}));

vi.mock('@caldav-bridge/backend-data/dao', () => ({
  OAuth2AuthorizationSessionDAO: class {
    create = sessionSpies.create;
    getActive = sessionSpies.getActive;
    consume = sessionSpies.consume;
  },
}));

vi.mock('@caldav-bridge/backend-services/oauth2/OAuth2AccessTokenService', () => ({
  OAuth2AccessTokenService: { completeAuthorization: tokenSpies.completeAuthorization },
}));

import { OAuth2AuthorizationService } from '@caldav-bridge/backend-services/oauth2/OAuth2AuthorizationService';
import type { OAuth2AuthorizationEnv } from '@caldav-bridge/backend-services/oauth2';

function testEnv(): OAuth2AuthorizationEnv {
  return {
    DB: {},
    AES_ENCRYPTION_KEY_SECRET: { get: async () => 'master-key' },
    OAUTH2_TOKEN_CACHE: {},
  } as unknown as OAuth2AuthorizationEnv;
}

function application(): Record<string, unknown> {
  return {
    applicationId: 'app-1',
    providerId: 'google-calendar',
    credentials: { clientId: 'client-id', clientSecret: 'client-secret' },
  };
}

describe('OAuth2AuthorizationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates authorization sessions with PKCE and provider URLs', async () => {
    sessionSpies.create.mockResolvedValue(undefined);

    const result = await new OAuth2AuthorizationService(testEnv()).createAuthorization(application() as never, 'https://bridge.example.test');

    expect(result.redirectUri).toBe('https://bridge.example.test/api/oauth2/callback/app-1');
    expect(result.authorizationUrl).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    expect(result.authorizationUrl).toContain(`redirect_uri=${encodeURIComponent(result.redirectUri)}`);
    expect(result.expiresAt).toBeGreaterThan(0);
    expect(sessionSpies.create).toHaveBeenCalledOnce();
    const createArgs = sessionSpies.create.mock.calls[0] as unknown[];
    expect(createArgs[0]).toBe('app-1');
    expect(typeof createArgs[1]).toBe('string');
    expect(typeof createArgs[2]).toBe('string');
    expect(createArgs[3]).toBe(result.redirectUri);
  });

  it('redirects provider errors without touching sessions', async () => {
    const result = await new OAuth2AuthorizationService(testEnv()).completeCallback('app-1', null, null, 'access_denied');

    expect(result).toEqual({ redirect: '/user?oauth2=error&message=access_denied' });
    expect(sessionSpies.getActive).not.toHaveBeenCalled();
  });

  it('rejects callbacks missing code, state, or sessions', async () => {
    const service = new OAuth2AuthorizationService(testEnv());

    await expect(service.completeCallback('app-1', null, 'state', null)).rejects.toBeInstanceOf(BadRequestError);
    await expect(service.completeCallback('app-1', 'code', null, null)).rejects.toBeInstanceOf(BadRequestError);

    sessionSpies.getActive.mockResolvedValue(undefined);
    await expect(service.completeCallback('app-1', 'code', 'state', null)).rejects.toThrow('OAuth2 authorization session is invalid or expired.');
  });

  it('completes valid callbacks and consumes the session', async () => {
    sessionSpies.getActive.mockResolvedValue({ sessionId: 'sess-1', redirectUri: 'https://bridge.example.test/cb', codeVerifier: 'verifier' });
    sessionSpies.consume.mockResolvedValue(undefined);
    tokenSpies.completeAuthorization.mockResolvedValue(undefined);

    const result = await new OAuth2AuthorizationService(testEnv()).completeCallback('app-1', 'code-value', 'state-value', null);

    expect(result).toEqual({ redirect: '/user?oauth2=connected&applicationId=app-1' });
    expect(tokenSpies.completeAuthorization).toHaveBeenCalledWith('app-1', 'https://bridge.example.test/cb', 'code-value', 'verifier', expect.anything());
    expect(sessionSpies.consume).toHaveBeenCalledWith('sess-1');
  });
});
