import type { CalDavCredential } from '../types';
import { apiFetch, readJson } from '../lib/api';

export async function listCredentials(applicationId: string): Promise<CalDavCredential[]> {
  const data = await readJson<{ credentials: CalDavCredential[] }>(
    await apiFetch(`/user/application/caldav-credentials?applicationId=${encodeURIComponent(applicationId)}`),
  );
  return data.credentials;
}

export async function createCredential(applicationId: string, name: string): Promise<{ password: string; metadata: CalDavCredential }> {
  return readJson<{ password: string; metadata: CalDavCredential }>(
    await apiFetch('/user/application/caldav-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ applicationId, name }),
    }),
  );
}

export async function deleteCredential(applicationId: string, credentialId: string): Promise<void> {
  await readJson<{ success: boolean }>(
    await apiFetch('/user/application/caldav-credential', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ applicationId, credentialId }),
    }),
  );
}
