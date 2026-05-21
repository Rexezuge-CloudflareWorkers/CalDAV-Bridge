import { useEffect, useState } from 'react';

type ProviderId = 'google-calendar' | 'microsoft-outlook-calendar';

interface CurrentUser {
  email: string;
  limits: {
    maxApplicationsPerUser: number;
    maxCalDavCredentialsPerApplication: number;
    defaultCalDavCredentialExpiryDays: number;
  };
}

interface ConnectedApplication {
  applicationId: string;
  displayName: string;
  providerId: ProviderId;
  providerEmail?: string | null;
  status: 'draft' | 'connected' | 'error';
  oauth2RedirectUri?: string;
  caldavBaseUrl?: string;
  credentialCount?: number;
}

interface CalDavCredential {
  credentialId: string;
  name: string;
  username: string;
  passwordPrefix: string;
  passwordLastFour: string;
  expiresAt: number;
  lastUsedAt?: number | null;
}

interface ProviderCalendar {
  id: string;
  name: string;
  timeZone?: string;
  readOnly?: boolean;
}

type Route = { page: 'applications' } | { page: 'connect' } | { page: 'details'; applicationId: string };

const providerLabels: Record<ProviderId, string> = {
  'google-calendar': 'Google Calendar',
  'microsoft-outlook-calendar': 'Outlook Calendar',
};

function parseRoute(): Route {
  const path = window.location.pathname.replace(/\/$/, '');
  const detailsMatch = path.match(/^\/user\/apps\/([^/]+)$/);
  if (detailsMatch?.[1]) return { page: 'details', applicationId: decodeURIComponent(detailsMatch[1]) };
  if (path === '/user/connect') return { page: 'connect' };
  return { page: 'applications' };
}

function routePath(route: Route): string {
  if (route.page === 'connect') return '/user/connect';
  if (route.page === 'details') return `/user/apps/${encodeURIComponent(route.applicationId)}`;
  return '/user/apps';
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string });
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data as T;
}

function formatTimestamp(timestamp?: number | null): string {
  return timestamp ? new Date(timestamp * 1000).toLocaleString() : 'Never';
}

export default function SpaApp() {
  const [route, setRoute] = useState<Route>(() => parseRoute());
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [applications, setApplications] = useState<ConnectedApplication[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [providerId, setProviderId] = useState<ProviderId>('google-calendar');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [credentials, setCredentials] = useState<CalDavCredential[]>([]);
  const [calendars, setCalendars] = useState<ProviderCalendar[]>([]);
  const [credentialName, setCredentialName] = useState('Desktop calendar');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const selectedApplication =
    route.page === 'details' ? applications.find((application) => application.applicationId === route.applicationId) : undefined;

  useEffect(() => {
    const handlePopState = () => setRoute(parseRoute());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthResult = params.get('oauth2');
    const connectedApplicationId = params.get('applicationId');
    if (oauthResult === 'connected') {
      setNotice('OAuth2 connection completed.');
      if (connectedApplicationId) replaceRoute({ page: 'details', applicationId: connectedApplicationId });
    }
    if (oauthResult === 'error') {
      setError(params.get('message') || 'OAuth2 connection failed.');
      window.history.replaceState(null, '', routePath(parseRoute()));
    }
    loadInitial().catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : 'Unable to load CalDAV Bridge.'));
  }, []);

  useEffect(() => {
    setNewUsername('');
    setNewPassword('');
    if (route.page !== 'details') return;
    if (!selectedApplication) {
      setCredentials([]);
      setCalendars([]);
      return;
    }
    Promise.all([loadCredentials(selectedApplication.applicationId), loadCalendars(selectedApplication)]).catch((loadError: unknown) =>
      setError(loadError instanceof Error ? loadError.message : 'Unable to load application details.'),
    );
  }, [route, selectedApplication]);

  function navigate(route: Route) {
    window.history.pushState(null, '', routePath(route));
    setRoute(route);
  }

  function replaceRoute(route: Route) {
    window.history.replaceState(null, '', routePath(route));
    setRoute(route);
  }

  async function loadInitial() {
    const me = await readJson<CurrentUser>(await fetch('/user/me'));
    setUser(me);
    await loadApplications();
  }

  async function loadApplications(): Promise<ConnectedApplication[]> {
    const data = await readJson<{ applications: ConnectedApplication[] }>(await fetch('/user/applications'));
    setApplications(data.applications);
    return data.applications;
  }

  async function loadCredentials(applicationId: string) {
    const data = await readJson<{ credentials: CalDavCredential[] }>(
      await fetch(`/user/application/caldav-credentials?applicationId=${encodeURIComponent(applicationId)}`),
    );
    setCredentials(data.credentials);
  }

  async function loadCalendars(application: ConnectedApplication) {
    if (application.status !== 'connected') {
      setCalendars([]);
      return;
    }
    const data = await readJson<{ calendars: ProviderCalendar[] }>(
      await fetch(`/user/application/calendars?applicationId=${encodeURIComponent(application.applicationId)}`),
    );
    setCalendars(data.calendars);
  }

  async function saveApplication() {
    setError('');
    const data = await readJson<{ application: ConnectedApplication }>(
      await fetch('/user/application', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName, providerId, connectionMethod: 'oauth2', clientId, clientSecret }),
      }),
    );
    setNotice('Application created.');
    setDisplayName('');
    setClientId('');
    setClientSecret('');
    await loadApplications();
    navigate({ page: 'details', applicationId: data.application.applicationId });
  }

  async function startOAuth2(applicationId: string) {
    const data = await readJson<{ authorizationUrl: string }>(
      await fetch('/user/application/oauth2/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationId }),
      }),
    );
    window.location.assign(data.authorizationUrl);
  }

  async function createCredential() {
    if (route.page !== 'details') return;
    const data = await readJson<{ password: string; metadata: CalDavCredential }>(
      await fetch('/user/application/caldav-credential', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationId: route.applicationId, name: credentialName }),
      }),
    );
    setNewUsername(data.metadata.username);
    setNewPassword(data.password);
    setNotice('CalDAV credentials created. Save the password now; it will not be shown again.');
    await loadCredentials(route.applicationId);
  }

  async function deleteCredential(credentialId: string) {
    if (route.page !== 'details') return;
    await readJson<{ success: boolean }>(
      await fetch('/user/application/caldav-credential', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationId: route.applicationId, credentialId }),
      }),
    );
    setNotice('CalDAV password deleted.');
    await loadCredentials(route.applicationId);
  }

  async function copyValue(value: string | undefined, label: string) {
    if (!value) return;
    setError('');
    await navigator.clipboard.writeText(value);
    setNotice(`${label} copied.`);
  }

  if (!user) return <div className="screen center">Loading CalDAV Bridge...</div>;

  return (
    <div className="screen">
      <header>
        <div>
          <span>CalDAV</span> Bridge
        </div>
        <nav aria-label="Primary navigation">
          <button className={route.page === 'applications' ? 'nav-link active' : 'nav-link'} onClick={() => navigate({ page: 'applications' })}>
            Applications
          </button>
          <button className={route.page === 'connect' ? 'nav-link active' : 'nav-link'} onClick={() => navigate({ page: 'connect' })}>
            Connect Calendar
          </button>
        </nav>
        <small>{user.email}</small>
      </header>
      {(notice || error) && <div className={error ? 'notice error' : 'notice'}>{error || notice}</div>}
      <main>
        {route.page === 'applications' && (
          <section className="page-stack">
            <div className="hero panel">
              <div>
                <p className="eyebrow">Calendar connections</p>
                <h1>Applications</h1>
                <p className="muted">Manage OAuth calendar applications and open each one for CalDAV credentials and calendars.</p>
              </div>
              <button onClick={() => navigate({ page: 'connect' })}>Connect Calendar</button>
            </div>
            <section className="panel">
              <div className="section-title">
                <h2>Your Applications</h2>
                <span>
                  {applications.length}/{user.limits.maxApplicationsPerUser}
                </span>
              </div>
              {applications.length ? (
                <div className="application-grid">
                  {applications.map((application) => (
                    <button
                      className="application-card"
                      key={application.applicationId}
                      onClick={() => navigate({ page: 'details', applicationId: application.applicationId })}
                    >
                      <span className={`status ${application.status}`}>{application.status}</span>
                      <strong>{application.displayName}</strong>
                      <small>{providerLabels[application.providerId]}</small>
                      <small>{application.providerEmail || 'OAuth not connected'}</small>
                      <span>{application.credentialCount || 0} app passwords</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <h3>No applications yet</h3>
                  <p className="muted">Create an application to connect Google Calendar or Outlook Calendar.</p>
                  <button onClick={() => navigate({ page: 'connect' })}>Connect Calendar</button>
                </div>
              )}
            </section>
          </section>
        )}

        {route.page === 'connect' && (
          <section className="page-stack narrow">
            <div className="page-heading">
              <p className="eyebrow">New connection</p>
              <h1>Connect Calendar</h1>
              <p className="muted">Create one OAuth application at a time. You can connect OAuth2 and generate CalDAV app passwords after it is saved.</p>
            </div>
            <section className="panel form-panel">
              <label>
                Name
                <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Work calendar" />
              </label>
              <label>
                Provider
                <select value={providerId} onChange={(event) => setProviderId(event.target.value as ProviderId)}>
                  <option value="google-calendar">Google Calendar</option>
                  <option value="microsoft-outlook-calendar">Outlook Calendar</option>
                </select>
              </label>
              <label>
                OAuth client ID
                <input value={clientId} onChange={(event) => setClientId(event.target.value)} />
              </label>
              <label>
                OAuth client secret
                <input value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} type="password" />
              </label>
              <div className="form-actions">
                <button onClick={() => saveApplication().catch((saveError) => setError(saveError.message))}>Create Application</button>
                <button className="secondary" onClick={() => navigate({ page: 'applications' })}>
                  Cancel
                </button>
              </div>
            </section>
          </section>
        )}

        {route.page === 'details' && (
          <section className="page-stack application-detail-page">
            {selectedApplication ? (
              <>
                <div className="hero panel detail-hero">
                  <div>
                    <button className="text-link" onClick={() => navigate({ page: 'applications' })}>
                      Back to applications
                    </button>
                    <p className="eyebrow">{providerLabels[selectedApplication.providerId]}</p>
                    <h1>{selectedApplication.displayName}</h1>
                    <p className="muted">{selectedApplication.providerEmail || 'OAuth is not connected yet.'}</p>
                  </div>
                  <button onClick={() => startOAuth2(selectedApplication.applicationId).catch((oauthError) => setError(oauthError.message))}>
                    {selectedApplication.status === 'connected' ? 'Reconnect OAuth2' : 'Connect OAuth2'}
                  </button>
                </div>

                <section className="panel detail-grid">
                  <div>
                    <h2>Connection Details</h2>
                    <p className="muted">Use these values when configuring the OAuth provider and CalDAV client.</p>
                  </div>
                  <div className="detail-list">
                    <div>
                      <span>Status</span>
                      <strong className={`status ${selectedApplication.status}`}>{selectedApplication.status}</strong>
                    </div>
                    <div>
                      <span>Redirect URI</span>
                      <div className="copy-value">
                        <code>{selectedApplication.oauth2RedirectUri}</code>
                        <button
                          className="secondary copy-button"
                          disabled={!selectedApplication.oauth2RedirectUri}
                          aria-label="Copy Redirect URI"
                          onClick={() => copyValue(selectedApplication.oauth2RedirectUri, 'Redirect URI').catch((copyError) => setError(copyError.message))}
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                    <div>
                      <span>CalDAV URL</span>
                      <div className="copy-value">
                        <code>{selectedApplication.caldavBaseUrl}</code>
                        <button
                          className="secondary copy-button"
                          disabled={!selectedApplication.caldavBaseUrl}
                          aria-label="Copy CalDAV URL"
                          onClick={() => copyValue(selectedApplication.caldavBaseUrl, 'CalDAV URL').catch((copyError) => setError(copyError.message))}
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                  </div>
                </section>

                <div className="detail-split">
                  <section className="panel detail-panel credentials-panel">
                    <div className="section-title">
                      <div>
                        <h2>CalDAV App Passwords</h2>
                        <p className="muted">Generate per-client credentials after OAuth2 is connected.</p>
                      </div>
                      <span>
                        {credentials.length}/{user.limits.maxCalDavCredentialsPerApplication}
                      </span>
                    </div>
                    <div className="row credential-row">
                      <input value={credentialName} onChange={(event) => setCredentialName(event.target.value)} />
                      <button onClick={() => createCredential().catch((credentialError) => setError(credentialError.message))}>Generate</button>
                    </div>
                    {newPassword && (
                      <div className="secret">
                        <strong>New username:</strong>
                        <code>{newUsername}</code>
                        <strong>New password:</strong>
                        <code>{newPassword}</code>
                      </div>
                    )}
                    {credentials.length ? (
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Name</th>
                              <th>Username</th>
                              <th>Password</th>
                              <th>Last used</th>
                              <th>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {credentials.map((credential) => (
                              <tr key={credential.credentialId}>
                                <td>{credential.name}</td>
                                <td>
                                  <code>{credential.username}</code>
                                </td>
                                <td>
                                  <code>
                                    {credential.passwordPrefix}...{credential.passwordLastFour}
                                  </code>
                                </td>
                                <td>{formatTimestamp(credential.lastUsedAt)}</td>
                                <td>
                                  <button
                                    className="danger"
                                    onClick={() => deleteCredential(credential.credentialId).catch((deleteError) => setError(deleteError.message))}
                                  >
                                    Delete
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="muted">No CalDAV app passwords have been generated for this application.</p>
                    )}
                  </section>

                  <section className="panel detail-panel calendars-panel">
                    <div className="section-title">
                      <h2>Calendars</h2>
                      <span>{calendars.length}</span>
                    </div>
                    {calendars.length ? (
                      <div className="calendar-grid">
                        {calendars.map((calendar) => (
                          <div className="calendar" key={calendar.id}>
                            <strong>{calendar.name}</strong>
                            <small>
                              {calendar.timeZone || 'Provider timezone'} {calendar.readOnly ? '· read-only' : ''}
                            </small>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="muted">Calendars will appear here after OAuth2 is connected.</p>
                    )}
                  </section>
                </div>
              </>
            ) : (
              <section className="panel empty-state">
                <h1>Application not found</h1>
                <p className="muted">The selected application could not be found for your account.</p>
                <button onClick={() => navigate({ page: 'applications' })}>Back to Applications</button>
              </section>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
