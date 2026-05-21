import type { ConnectedApplicationStatus, ConnectionMethod, ProviderId } from '../constants';

interface OAuth2Credentials {
  clientId: string;
  clientSecret: string;
  refreshToken?: string | undefined;
}

type ConnectedApplicationCredentials = OAuth2Credentials;

interface ConnectedApplicationMetadata {
  applicationId: string;
  userEmail: string;
  providerEmail?: string | null | undefined;
  displayName: string;
  providerId: ProviderId;
  connectionMethod: ConnectionMethod;
  status: ConnectedApplicationStatus;
  oauth2RedirectUri?: string | undefined;
  caldavBaseUrl?: string | undefined;
  calendarCount?: number | undefined;
  credentialCount?: number | undefined;
  lastError?: string | null | undefined;
  createdAt: number;
  updatedAt: number;
}

interface ConnectedApplication extends ConnectedApplicationMetadata {
  credentials: ConnectedApplicationCredentials;
}

interface ConnectedApplicationInternal {
  application_id: string;
  user_email: string;
  provider_email: string | null;
  display_name: string;
  provider_id: ProviderId;
  connection_method: ConnectionMethod;
  encrypted_credentials: string;
  credentials_iv: string;
  status: ConnectedApplicationStatus;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export type {
  ConnectedApplication,
  ConnectedApplicationCredentials,
  ConnectedApplicationInternal,
  ConnectedApplicationMetadata,
  OAuth2Credentials,
};
