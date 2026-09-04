import type { ConnectedApplication, ProviderId } from '../types';
import { apiFetch, readJson } from '../lib/api';

export async function listApplications(): Promise<ConnectedApplication[]> {
  const data = await readJson<{ applications: ConnectedApplication[] }>(await apiFetch('/user/applications'));
  return data.applications;
}

export async function createApplication(input: {
  displayName: string;
  providerId: ProviderId;
  clientId: string;
  clientSecret: string;
}): Promise<ConnectedApplication> {
  const data = await readJson<{ application: ConnectedApplication }>(
    await apiFetch('/user/application', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, connectionMethod: 'oauth2' }),
    }),
  );
  return data.application;
}
