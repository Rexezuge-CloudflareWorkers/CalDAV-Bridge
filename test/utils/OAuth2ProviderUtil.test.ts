import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_GOOGLE_CALENDAR, PROVIDER_MICROSOFT_OUTLOOK_CALENDAR } from '@caldav-bridge/shared/constants';
import { HttpError, OAuth2ProviderUtil } from '@/utils';

describe('OAuth2ProviderUtil', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds Google authorization URLs with offline calendar consent and PKCE', () => {
    const url = new URL(
      OAuth2ProviderUtil.buildAuthorizationUrl({
        providerId: PROVIDER_GOOGLE_CALENDAR,
        clientId: 'client-id',
        redirectUri: 'https://bridge.example.test/callback',
        state: 'state-value',
        codeChallenge: 'challenge-value',
      }),
    );

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://bridge.example.test/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(url.searchParams.get('state')).toBe('state-value');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('builds Microsoft authorization URLs with Graph scopes and query response mode', () => {
    const url = new URL(
      OAuth2ProviderUtil.buildAuthorizationUrl({
        providerId: PROVIDER_MICROSOFT_OUTLOOK_CALENDAR,
        clientId: 'client-id',
        redirectUri: 'https://bridge.example.test/callback',
        state: 'state-value',
        codeChallenge: 'challenge-value',
      }),
    );

    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
    expect(url.searchParams.get('scope')).toContain('https://graph.microsoft.com/Calendars.ReadWrite');
    expect(url.searchParams.get('scope')).toContain('offline_access');
    expect(url.searchParams.get('response_mode')).toBe('query');
  });

  it('rejects unsupported providers before making token requests', async () => {
    expect(() =>
      OAuth2ProviderUtil.buildAuthorizationUrl({
        providerId: 'unsupported',
        clientId: 'client-id',
        redirectUri: 'https://bridge.example.test/callback',
        state: 'state-value',
        codeChallenge: 'challenge-value',
      }),
    ).toThrow(HttpError);

    await expect(
      OAuth2ProviderUtil.exchangeCode({
        providerId: 'unsupported',
        credentials: { clientId: 'client-id', clientSecret: 'client-secret' },
        redirectUri: 'https://bridge.example.test/callback',
        code: 'code',
        codeVerifier: 'verifier',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('exchanges authorization codes with x-www-form-urlencoded PKCE bodies', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: '3600' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      OAuth2ProviderUtil.exchangeCode({
        providerId: PROVIDER_MICROSOFT_OUTLOOK_CALENDAR,
        credentials: { clientId: 'client-id', clientSecret: 'client-secret' },
        redirectUri: 'https://bridge.example.test/callback',
        code: 'code-value',
        codeVerifier: 'verifier-value',
      }),
    ).resolves.toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token', expiresIn: 3600 });

    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_id')).toBe('client-id');
    expect(body.get('client_secret')).toBe('client-secret');
    expect(body.get('code')).toBe('code-value');
    expect(body.get('code_verifier')).toBe('verifier-value');
    expect(body.get('redirect_uri')).toBe('https://bridge.example.test/callback');
  });

  it('requires refresh tokens during initial OAuth2 exchange', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ access_token: 'access-token', expires_in: 3600 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      OAuth2ProviderUtil.exchangeCode({
        providerId: PROVIDER_GOOGLE_CALENDAR,
        credentials: { clientId: 'client-id', clientSecret: 'client-secret' },
        redirectUri: 'https://bridge.example.test/callback',
        code: 'code-value',
        codeVerifier: 'verifier-value',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refreshes access tokens and preserves missing replacement refresh tokens', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ access_token: 'new-access-token', expires_in: 1200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      OAuth2ProviderUtil.refreshAccessToken({
        providerId: PROVIDER_GOOGLE_CALENDAR,
        credentials: { clientId: 'client-id', clientSecret: 'client-secret', refreshToken: 'refresh-token' },
      }),
    ).resolves.toEqual({ accessToken: 'new-access-token', refreshToken: undefined, expiresIn: 1200 });

    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://oauth2.googleapis.com/token');
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-token');
  });

  it('maps OAuth2 provider token failures to HttpError status codes', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant', error_description: 'Bad code' }, 400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      OAuth2ProviderUtil.exchangeCode({
        providerId: PROVIDER_GOOGLE_CALENDAR,
        credentials: { clientId: 'client-id', clientSecret: 'client-secret' },
        redirectUri: 'https://bridge.example.test/callback',
        code: 'code-value',
        codeVerifier: 'verifier-value',
      }),
    ).rejects.toMatchObject({ status: 400, message: 'OAuth2 token request failed: Bad code' });
  });

  it('rejects refresh requests before calling providers when credentials are incomplete', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      OAuth2ProviderUtil.refreshAccessToken({
        providerId: PROVIDER_GOOGLE_CALENDAR,
        credentials: { clientId: 'client-id', clientSecret: 'client-secret' },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
