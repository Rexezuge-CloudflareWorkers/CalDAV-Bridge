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

const providerLabels: Record<ProviderId, string> = {
  'google-calendar': 'Google Calendar',
  'microsoft-outlook-calendar': 'Outlook Calendar',
};

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
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [applications, setApplications] = useState<ConnectedApplication[]>([]);
  const [selectedApplicationId, setSelectedApplicationId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [providerId, setProviderId] = useState<ProviderId>('google-calendar');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [credentials, setCredentials] = useState<CalDavCredential[]>([]);
  const [calendars, setCalendars] = useState<ProviderCalendar[]>([]);
  const [credentialName, setCredentialName] = useState('Desktop calendar');
  const [newPassword, setNewPassword] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const selectedApplication = applications.find((application) => application.applicationId === selectedApplicationId);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('oauth2') === 'connected') setNotice('OAuth2 connection completed.');
    if (params.get('oauth2') === 'error') setError(params.get('message') || 'OAuth2 connection failed.');
    loadInitial().catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : 'Unable to load CalDAV Bridge.'));
  }, []);

  useEffect(() => {
    if (!selectedApplicationId) return;
    Promise.all([loadCredentials(selectedApplicationId), loadCalendars(selectedApplicationId)]).catch((loadError: unknown) =>
      setError(loadError instanceof Error ? loadError.message : 'Unable to load application details.'),
    );
  }, [selectedApplicationId]);

  async function loadInitial() {
    const me = await readJson<CurrentUser>(await fetch('/user/me'));
    setUser(me);
    await loadApplications();
  }

  async function loadApplications() {
    const data = await readJson<{ applications: ConnectedApplication[] }>(await fetch('/user/applications'));
    setApplications(data.applications);
    setSelectedApplicationId((current) => current || data.applications[0]?.applicationId || '');
  }

  async function loadCredentials(applicationId: string) {
    const data = await readJson<{ credentials: CalDavCredential[] }>(await fetch(`/user/application/caldav-credentials?applicationId=${encodeURIComponent(applicationId)}`));
    setCredentials(data.credentials);
  }

  async function loadCalendars(applicationId: string) {
    const app = applications.find((application) => application.applicationId === applicationId);
    if (!app || app.status !== 'connected') {
      setCalendars([]);
      return;
    }
    const data = await readJson<{ calendars: ProviderCalendar[] }>(await fetch(`/user/application/calendars?applicationId=${encodeURIComponent(applicationId)}`));
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
    setSelectedApplicationId(data.application.applicationId);
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
    if (!selectedApplicationId) return;
    const data = await readJson<{ password: string; metadata: CalDavCredential }>(
      await fetch('/user/application/caldav-credential', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationId: selectedApplicationId, name: credentialName }),
      }),
    );
    setNewPassword(data.password);
    setNotice('CalDAV password created. Save it now; it will not be shown again.');
    await loadCredentials(selectedApplicationId);
  }

  async function deleteCredential(credentialId: string) {
    if (!selectedApplicationId) return;
    await readJson<{ success: boolean }>(
      await fetch('/user/application/caldav-credential', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationId: selectedApplicationId, credentialId }),
      }),
    );
    setNotice('CalDAV password deleted.');
    await loadCredentials(selectedApplicationId);
  }

  if (!user) return <div className="screen center">Loading CalDAV Bridge...</div>;

  return (
    <div className="screen">
      <header>
        <div><span>Cal</span>Bridge</div>
        <small>{user.email}</small>
      </header>
      {(notice || error) && <div className={error ? 'notice error' : 'notice'}>{error || notice}</div>}
      <main>
        <section className="panel create">
          <h1>Connect Calendar</h1>
          <label>Name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Work calendar" /></label>
          <label>Provider<select value={providerId} onChange={(event) => setProviderId(event.target.value as ProviderId)}><option value="google-calendar">Google Calendar</option><option value="microsoft-outlook-calendar">Outlook Calendar</option></select></label>
          <label>OAuth client ID<input value={clientId} onChange={(event) => setClientId(event.target.value)} /></label>
          <label>OAuth client secret<input value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} type="password" /></label>
          <button onClick={() => saveApplication().catch((saveError) => setError(saveError.message))}>Create Application</button>
        </section>
        <section className="panel list">
          <div className="section-title"><h2>Applications</h2><span>{applications.length}/{user.limits.maxApplicationsPerUser}</span></div>
          {applications.map((application) => <button className={application.applicationId === selectedApplicationId ? 'card selected' : 'card'} key={application.applicationId} onClick={() => setSelectedApplicationId(application.applicationId)}><strong>{application.displayName}</strong><small>{providerLabels[application.providerId]} · {application.status}</small><small>{application.providerEmail || 'OAuth not connected'}</small></button>)}
        </section>
        <section className="panel detail">
          {selectedApplication ? <>
            <h2>{selectedApplication.displayName}</h2>
            <p className="muted">Redirect URI: <code>{selectedApplication.oauth2RedirectUri}</code></p>
            <p className="muted">CalDAV URL: <code>{selectedApplication.caldavBaseUrl}</code></p>
            <button onClick={() => startOAuth2(selectedApplication.applicationId).catch((oauthError) => setError(oauthError.message))}>Connect OAuth2</button>
            <h3>CalDAV App Passwords</h3>
            <div className="row"><input value={credentialName} onChange={(event) => setCredentialName(event.target.value)} /><button onClick={() => createCredential().catch((credentialError) => setError(credentialError.message))}>Generate</button></div>
            {newPassword && <div className="secret"><strong>New password:</strong><code>{newPassword}</code></div>}
            <table><tbody>{credentials.map((credential) => <tr key={credential.credentialId}><td>{credential.name}</td><td><code>{credential.passwordPrefix}...{credential.passwordLastFour}</code></td><td>{formatTimestamp(credential.lastUsedAt)}</td><td><button onClick={() => deleteCredential(credential.credentialId).catch((deleteError) => setError(deleteError.message))}>Delete</button></td></tr>)}</tbody></table>
            <h3>Calendars</h3>
            <div className="calendar-grid">{calendars.map((calendar) => <div className="calendar" key={calendar.id}><strong>{calendar.name}</strong><small>{calendar.timeZone || 'Provider timezone'} {calendar.readOnly ? '· read-only' : ''}</small></div>)}</div>
          </> : <p>Select an application.</p>}
        </section>
      </main>
    </div>
  );
}
