import { BadRequestError, InternalServerError, NotFoundError, ServiceUnavailableError } from '@caldav-bridge/backend-errors';

const MAX_THROTTLE_RETRY_ATTEMPTS = 2;
const MAX_RETRY_AFTER_SECONDS = 2;

async function fetchProviderJson<T>(url: string, accessToken: string, init: RequestInit = {}): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${accessToken}`);
    const response = await fetch(url, { ...init, headers });
    const text = await response.text();
    const data = text ? (parseProviderJson<T & { error?: { message?: string } }>(text) ?? ({} as T & { error?: { message?: string } })) : ({} as T & { error?: { message?: string } });
    if (response.ok) return data as T;

    if (response.status === 429 && attempt < MAX_THROTTLE_RETRY_ATTEMPTS) {
      const retryDelay = retryDelayMilliseconds(response.headers.get('Retry-After'), attempt);
      if (retryDelay <= MAX_RETRY_AFTER_SECONDS * 1000) {
        await delay(retryDelay);
        continue;
      }
    }

    throw providerError(response, text, data);
  }
}

function providerError(response: Response, text: string, data: { error?: { message?: string } }): Error {
  const message = `Calendar provider request failed (${response.status}): ${data.error?.message || text || response.statusText}`;
  if (response.status === 404 || response.status === 410) return new NotFoundError(message);
  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    const error = new ServiceUnavailableError(message);
    if (retryAfter) error.headers = { 'Retry-After': retryAfter };
    return error;
  }
  if (response.status >= 400 && response.status < 500) return new BadRequestError(message);
  return new InternalServerError(message);
}

async function fetchGraphPages<T>(url: string, accessToken: string, init: RequestInit = {}): Promise<T[]> {
  const items: T[] = [];
  let nextUrl: string | undefined = url;
  while (nextUrl) {
    const data: { value?: T[]; '@odata.nextLink'?: string } = await fetchProviderJson(nextUrl, accessToken, init);
    items.push(...(data.value || []));
    nextUrl = data['@odata.nextLink'];
  }
  return items;
}

function parseProviderJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function retryDelayMilliseconds(retryAfter: string | null, attempt: number): number {
  if (!retryAfter) return 250 * 2 ** attempt;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const retryAt = new Date(retryAfter).getTime();
  return Number.isNaN(retryAt) ? Number.POSITIVE_INFINITY : Math.max(0, retryAt - Date.now());
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export { fetchGraphPages, fetchProviderJson, parseProviderJson, providerError };
