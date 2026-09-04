export type ProviderId = 'google-calendar' | 'microsoft-outlook-calendar';

export type ApplicationStatus = 'draft' | 'connected' | 'error';

export interface CurrentUser {
  email: string;
  limits: {
    maxApplicationsPerUser: number;
    maxCalDavCredentialsPerApplication: number;
    defaultCalDavCredentialExpiryDays: number;
  };
}

export interface ConnectedApplication {
  applicationId: string;
  displayName: string;
  providerId: ProviderId;
  providerEmail?: string | null;
  status: ApplicationStatus;
  oauth2RedirectUri?: string;
  caldavBaseUrl?: string;
  credentialCount?: number;
}

export interface CalDavCredential {
  credentialId: string;
  name: string;
  username: string;
  passwordPrefix: string;
  passwordLastFour: string;
  expiresAt: number;
  lastUsedAt?: number | null;
}

export interface ProviderCalendar {
  id: string;
  name: string;
  timeZone?: string;
  readOnly?: boolean;
}

export type Route = { page: 'applications' } | { page: 'connect' } | { page: 'details'; applicationId: string };

export const providerLabels: Record<ProviderId, string> = {
  'google-calendar': 'Google Calendar',
  'microsoft-outlook-calendar': 'Outlook Calendar',
};

export function parseRoute(pathname: string): Route {
  const path = pathname.replace(/\/$/, '');
  const detailsMatch = path.match(/^\/user\/apps\/([^/]+)$/);
  if (detailsMatch?.[1]) return { page: 'details', applicationId: decodeURIComponent(detailsMatch[1]) };
  if (path === '/user/connect') return { page: 'connect' };
  return { page: 'applications' };
}

export function routePath(route: Route): string {
  if (route.page === 'connect') return '/user/connect';
  if (route.page === 'details') return `/user/apps/${encodeURIComponent(route.applicationId)}`;
  return '/user/apps';
}
