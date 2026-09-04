import { apiFetch, readJson } from '../lib/api';

export async function authorizeOAuth2(applicationId: string): Promise<string> {
  const data = await readJson<{ authorizationUrl: string }>(
    await apiFetch('/user/application/oauth2/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ applicationId }),
    }),
  );
  return data.authorizationUrl;
}
