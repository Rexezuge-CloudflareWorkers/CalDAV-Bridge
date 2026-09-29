const D1_BOOKMARK_HEADER: string = 'x-d1-bookmark';

let latestD1Bookmark: string | undefined;

export async function apiFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  const isUserRequest: boolean = getFetchPath(input).startsWith('/user/');
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (isUserRequest && latestD1Bookmark && !headers.has(D1_BOOKMARK_HEADER)) {
    headers.set(D1_BOOKMARK_HEADER, latestD1Bookmark);
  }

  const response: Response = await fetch(input, isUserRequest ? { ...init, headers } : init);
  if (isUserRequest) {
    rememberD1Bookmark(response.headers.get(D1_BOOKMARK_HEADER));
  }
  return response;
}

export async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    if (text) {
      try {
        const data = JSON.parse(text) as { error?: string };
        throw new Error(data.error || text || `HTTP ${response.status}`);
      } catch (error) {
        if (error instanceof Error && error.message !== text) throw error;
        throw new Error(text || `HTTP ${response.status}`);
      }
    }
    throw new Error(response.statusText || `HTTP ${response.status}`);
  }
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

export function formatTimestamp(timestampSeconds: number | null | undefined): string {
  if (timestampSeconds === null || timestampSeconds === undefined) return 'Never';
  const diffMins = minutesSince(timestampSeconds);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(timestampSeconds * 1000).toLocaleDateString();
}

/**
 * How long until a credential expires, or how long ago it did.
 *
 * The expired case is handled explicitly rather than falling out of the
 * comparisons below. `diffMins` is negative for a past timestamp, and the
 * "expires soon" test is `diffMins < 1` -- so an already-expired credential
 * matched it and was reported as expiring shortly, which is the one thing a
 * user checking an expired credential is not being told.
 */
export function formatExpiryTimestamp(timestampSeconds: number | null | undefined): string {
  if (timestampSeconds === null || timestampSeconds === undefined) return 'Never';
  const diffMins = minutesUntil(timestampSeconds);
  if (diffMins < 0) return 'Expired';
  if (diffMins < 1) return 'Expires soon';
  if (diffMins < 60) return `Expires in ${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `Expires in ${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `Expires in ${diffDays}d`;
  return `Expires ${new Date(timestampSeconds * 1000).toLocaleDateString()}`;
}

/** Whole minutes since a Unix-seconds timestamp. */
function minutesSince(timestampSeconds: number): number {
  return Math.floor((Date.now() - timestampSeconds * 1000) / 60_000);
}

/** Whole minutes until a Unix-seconds timestamp; negative once it has passed. */
function minutesUntil(timestampSeconds: number): number {
  return Math.floor((timestampSeconds * 1000 - Date.now()) / 60_000);
}

function getFetchPath(input: Parameters<typeof fetch>[0]): string {
  const url: string = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
  return new URL(url, globalThis.location.origin).pathname;
}

function rememberD1Bookmark(bookmark: string | null): void {
  const nextBookmark: string | undefined = bookmark?.trim() || undefined;
  if (!nextBookmark) return;
  if (!latestD1Bookmark || latestD1Bookmark < nextBookmark) {
    latestD1Bookmark = nextBookmark;
  }
}
