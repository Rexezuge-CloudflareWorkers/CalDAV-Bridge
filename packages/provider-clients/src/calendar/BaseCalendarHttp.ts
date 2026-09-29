import {
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PreconditionFailedError,
  ServiceUnavailableError,
} from '@caldav-bridge/backend-errors';

const MAX_THROTTLE_RETRY_ATTEMPTS = 2;
const MAX_RETRY_AFTER_SECONDS = 2;
/**
 * Ceiling on one provider request.
 *
 * Without it a hung provider holds the invocation until the platform limit,
 * which is long enough to exhaust a user's daily request quota for a calendar
 * that has not actually changed.
 */
const PROVIDER_REQUEST_TIMEOUT_MS = 10_000;
/**
 * Ceiling on a paginated walk.
 *
 * The `while (nextUrl)` loop had no bound, so a provider returning a next link
 * forever -- or a calendar large enough to page indefinitely -- would loop until
 * the invocation died. Both pages and items are capped so the cost of any single
 * request is knowable in advance.
 */
const MAX_PAGES = 50;
const MAX_ITEMS = 20_000;

async function fetchProviderJson<T>(url: string, accessToken: string, init: RequestInit = {}): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${accessToken}`);
    const response = await fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS) });
    const text = await response.text();
    const data = text
      ? (parseProviderJson<T & { error?: { message?: string } }>(text) ?? ({} as T & { error?: { message?: string } }))
      : ({} as T & { error?: { message?: string } });
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
  // A provider conditional write that lost the race. Surfaced as a CalDAV
  // `412` so the client learns its view is stale instead of having its write
  // silently dropped.
  if (response.status === 412) return new PreconditionFailedError('The calendar object was modified elsewhere.');
  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    const error = new ServiceUnavailableError(message);
    if (retryAfter) error.headers = { 'Retry-After': retryAfter };
    return error;
  }
  if (response.status >= 400 && response.status < 500) return new BadRequestError(message);
  return new InternalServerError(message);
}

/**
 * Walk a paginated Graph collection, bounded.
 *
 * A truncated result is preferable to an unbounded walk: the caller still gets
 * the objects it can see, and a calendar too large to page through in one
 * request was never going to be served correctly anyway.
 */
async function fetchGraphPages<T>(url: string, accessToken: string, init: RequestInit = {}): Promise<T[]> {
  const items: T[] = [];
  let nextUrl: string | undefined = url;
  let page = 0;
  while (nextUrl && page < MAX_PAGES && items.length < MAX_ITEMS) {
    const data: { value?: T[]; '@odata.nextLink'?: string } = await fetchProviderJson(nextUrl, accessToken, init);
    items.push(...(data.value || []));
    nextUrl = data['@odata.nextLink'];
    page += 1;
  }
  return items.slice(0, MAX_ITEMS);
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
