import type { CalDavCredential } from '../types';
import { apiFetch, readJson } from '../lib/api';

export async function listCredentials(applicationId: string): Promise<CalDavCredential[]> {
  const data = await readJson<{ credentials: CalDavCredential[] }>(
    await apiFetch(`/user/application/caldav-credentials?applicationId=${encodeURIComponent(applicationId)}`),
  );
  return data.credentials;
}

/**
 * Issue a CalDAV credential.
 *
 * `expiresInDays` is optional and omitted rather than sent as a value when
 * unset, so the API applies its own configured default -- which is the limit the
 * operator chose, and is the one the UI has no way to know.
 */
export async function createCredential(
  applicationId: string,
  name: string,
  expiresInDays?: number,
): Promise<{ password: string; metadata: CalDavCredential }> {
  return readJson<{ password: string; metadata: CalDavCredential }>(
    await apiFetch('/user/application/caldav-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ applicationId, name, ...(expiresInDays === undefined ? {} : { expiresInDays }) }),
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
