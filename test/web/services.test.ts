import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Each service is a thin wrapper over one endpoint, so what is worth pinning down
 * is the request it builds -- the method, the path, the body -- and how it
 * unwraps the response. A wrong path or a missing `connectionMethod` fails at
 * the API with a validation error, which is slow to diagnose from the UI.
 */
const apiFetch = vi.hoisted(() => vi.fn());

vi.mock('~/lib/api', async () => {
  const actual = await vi.importActual<typeof import('~/lib/api')>('~/lib/api');
  return { ...actual, apiFetch };
});

/**
 * Each service module is loaded through a dynamic import, because they are
 * mocked per test file and a static import would capture the real ones. The
 * parameter is the module's real signature rather than `never[]`, so a call is
 * checked against it.
 */
const service = async <TModule>(name: string): Promise<TModule> => (await import(`~/services/${name}`)) as TModule;

type ApplicationService = typeof import('~/services/applicationService');
type CalendarService = typeof import('~/services/calendarService');
type CredentialService = typeof import('~/services/credentialService');
type UserService = typeof import('~/services/userService');
type OAuthService = typeof import('~/services/oauthService');

const APPLICATION = {
  applicationId: 'app-1',
  displayName: 'Primary',
  providerId: 'google-calendar',
  connectionMethod: 'oauth2',
  status: 'connected',
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('applicationService', () => {
  beforeEach(() => {
    apiFetch.mockResolvedValue(jsonResponse({ applications: [APPLICATION] }));
  });

  afterEach(() => {
    apiFetch.mockReset();
  });

  it('lists applications from the collection route', async () => {
    const { listApplications } = await service<ApplicationService>('applicationService');

    const applications = await listApplications();

    expect(apiFetch).toHaveBeenCalledWith('/user/applications');
    expect(applications).toEqual([APPLICATION]);
  });

  it('sends connectionMethod on create, which the API requires', async () => {
    // The API's schema pins `connectionMethod` to the literal 'oauth2', so
    // omitting it is a 400 rather than a defaulted field.
    apiFetch.mockResolvedValue(jsonResponse({ application: APPLICATION }));
    const { createApplication } = await service<ApplicationService>('applicationService');

    await createApplication({ displayName: 'Primary', providerId: 'google-calendar', clientId: 'id', clientSecret: 'secret' });

    const [path, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/user/application');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      displayName: 'Primary',
      providerId: 'google-calendar',
      clientId: 'id',
      clientSecret: 'secret',
      connectionMethod: 'oauth2',
    });
  });
});

describe('calendarService', () => {
  afterEach(() => {
    apiFetch.mockReset();
  });

  it('encodes the application id into the query string', async () => {
    // A raw id would split the query at its separator and silently request a
    // different calendar.
    apiFetch.mockResolvedValue(jsonResponse({ calendars: [] }));
    const { listCalendars } = await service<CalendarService>('calendarService');

    await listCalendars('app with spaces&more');

    expect(apiFetch).toHaveBeenCalledWith('/user/application/calendars?applicationId=app%20with%20spaces%26more');
  });
});

describe('credentialService', () => {
  afterEach(() => {
    apiFetch.mockReset();
  });

  it('lists credentials for an application', async () => {
    const credential = {
      credentialId: 'cred-1',
      name: 'Laptop',
      username: 'otter1234',
      passwordPrefix: 'cb_',
      passwordLastFour: 'abcd',
      expiresAt: 100,
    };
    apiFetch.mockResolvedValue(jsonResponse({ credentials: [credential] }));
    const { listCredentials } = await service<CredentialService>('credentialService');

    await listCredentials('app-1');

    expect(apiFetch).toHaveBeenCalledWith('/user/application/caldav-credentials?applicationId=app-1');
  });

  it('creates a credential with the supplied expiry', async () => {
    apiFetch.mockResolvedValue(jsonResponse({ password: 'cb_secret', metadata: { credentialId: 'cred-1' } }));
    const { createCredential } = await service<CredentialService>('credentialService');

    await createCredential('app-1', 'Laptop', 30);

    const [path, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/user/application/caldav-credential');
    expect(JSON.parse(init.body as string)).toEqual({ applicationId: 'app-1', name: 'Laptop', expiresInDays: 30 });
  });

  it('omits an unset expiry rather than sending undefined', async () => {
    apiFetch.mockResolvedValue(jsonResponse({ password: 'cb_secret', metadata: { credentialId: 'cred-1' } }));
    const { createCredential } = await service<CredentialService>('credentialService');

    await createCredential('app-1', 'Laptop');

    // `JSON.stringify` drops an undefined property, so this arrives as an
    // absent field and the API applies its own default.
    expect(JSON.parse((apiFetch.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({ applicationId: 'app-1', name: 'Laptop' });
  });

  it('deletes a credential by id', async () => {
    apiFetch.mockResolvedValue(jsonResponse({ success: true }));
    const { deleteCredential } = await service<CredentialService>('credentialService');

    await deleteCredential('app-1', 'cred-1');

    const [path, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/user/application/caldav-credential');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body as string)).toEqual({ applicationId: 'app-1', credentialId: 'cred-1' });
  });
});

describe('userService', () => {
  afterEach(() => {
    apiFetch.mockReset();
  });

  it('loads the current user', async () => {
    const user = { userId: 'user-1', email: 'owner@example.com', limits: { maxApplicationsPerUser: 99 } };
    apiFetch.mockResolvedValue(jsonResponse(user));
    const { loadCurrentUser } = await service<UserService>('userService');

    await expect(loadCurrentUser()).resolves.toEqual(user);
    expect(apiFetch).toHaveBeenCalledWith('/user/me');
  });
});

describe('oauthService', () => {
  afterEach(() => {
    apiFetch.mockReset();
  });

  it('asks for an authorization URL and returns the redirect target', async () => {
    // The response is a redirect, not a fetch: the browser has to leave for the
    // provider, so this must be read from the payload rather than followed.
    apiFetch.mockResolvedValue(jsonResponse({ authorizationUrl: 'https://provider.test/oauth?state=abc' }));
    const { authorizeOAuth2 } = await service<OAuthService>('oauthService');

    await expect(authorizeOAuth2('app-1')).resolves.toBe('https://provider.test/oauth?state=abc');
    expect(apiFetch).toHaveBeenCalledWith('/user/application/oauth2/authorize', expect.objectContaining({ method: 'POST' }));
  });
});
