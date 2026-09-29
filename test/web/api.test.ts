import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatExpiryTimestamp, formatTimestamp, readJson } from '~/lib/api';

/**
 * The D1 bookmark is how a read-after-write stays consistent: the API returns
 * the session's bookmark, and the client sends it back on the next request so
 * D1 replays rather than reading a replica that has not caught up. Losing it is
 * silent -- a user sees their own change missing until a reload -- and sending it
 * to the wrong route would leak a session token to a non-`/user/` endpoint.
 */
describe('apiFetch D1 bookmark handling', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  /**
   * The bookmark lives in module state, so each case gets a fresh copy of the
   * module. Without that, a bookmark learned by one test is still held by the
   * next, and the "no bookmark yet" cases would pass or fail by accident.
   */
  const freshApi = async (): Promise<typeof import('~/lib/api')> => {
    vi.resetModules();
    return import('~/lib/api');
  };

  const headerOn = (call: number): string | null => {
    const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
    return new Headers(init?.headers ?? {}).get('x-d1-bookmark');
  };

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('sends no bookmark on the first user request', async () => {
    const { apiFetch } = await freshApi();

    await apiFetch('/user/me');

    expect(headerOn(0)).toBeNull();
  });

  it('remembers a returned bookmark and sends it on the next user request', async () => {
    const { apiFetch } = await freshApi();
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'x-d1-bookmark': 'bookmark-1' } }));

    await apiFetch('/user/me');
    await apiFetch('/user/applications');

    expect(headerOn(1)).toBe('bookmark-1');
  });

  it('advances the bookmark rather than regressing it', async () => {
    // Responses can arrive out of order. Regressing would send a client back to
    // an older session and lose a write it had already been told about.
    const { apiFetch } = await freshApi();
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'x-d1-bookmark': 'bookmark-2' } }));
    await apiFetch('/user/me');

    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'x-d1-bookmark': 'bookmark-1' } }));
    await apiFetch('/user/applications');

    await apiFetch('/user/applications');

    expect(headerOn(2)).toBe('bookmark-2');
  });

  it('never sends the bookmark to a non-user route', async () => {
    // A session bookmark is a capability token. Sending it outside `/user/`
    // would attach it to a request that does not need it.
    const { apiFetch } = await freshApi();
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'x-d1-bookmark': 'bookmark-1' } }));
    await apiFetch('/user/me');

    await apiFetch('/dav/calendars/app-1/');

    expect(headerOn(1)).toBeNull();
  });

  it('leaves a bookmark the caller supplied alone', async () => {
    const { apiFetch } = await freshApi();
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'x-d1-bookmark': 'bookmark-1' } }));
    await apiFetch('/user/me');

    await apiFetch('/user/applications', { headers: { 'x-d1-bookmark': 'caller-supplied' } });

    expect(headerOn(1)).toBe('caller-supplied');
  });

  it('ignores a response with no bookmark rather than clearing what it has', async () => {
    const { apiFetch } = await freshApi();
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'x-d1-bookmark': 'bookmark-1' } }));
    await apiFetch('/user/me');

    await apiFetch('/user/applications');
    await apiFetch('/user/application');

    expect(headerOn(2)).toBe('bookmark-1');
  });

  it('ignores a blank bookmark', async () => {
    const { apiFetch } = await freshApi();
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'x-d1-bookmark': '   ' } }));

    await apiFetch('/user/me');
    await apiFetch('/user/applications');

    expect(headerOn(1)).toBeNull();
  });
});

describe('readJson', () => {
  it('parses a successful body', async () => {
    const response = new Response(JSON.stringify({ value: 1 }), { status: 200 });

    await expect(readJson<{ value: number }>(response)).resolves.toEqual({ value: 1 });
  });

  it('treats an empty successful body as an empty object', async () => {
    // A `204` from a delete has no body, and the callers destructure from it.
    await expect(readJson(new Response(null, { status: 204 }))).resolves.toEqual({});
  });

  it('surfaces the API error message', async () => {
    const response = new Response(JSON.stringify({ error: 'applicationId is required.' }), { status: 400 });

    await expect(readJson(response)).rejects.toThrow('applicationId is required.');
  });

  it('falls back to the raw text when the error body is not JSON', async () => {
    const response = new Response('<html>502 Bad Gateway</html>', { status: 502 });

    await expect(readJson(response)).rejects.toThrow('502');
  });

  it('falls back to the status text when there is no body at all', async () => {
    const response = new Response(null, { status: 503, statusText: 'Service Unavailable' });

    await expect(readJson(response)).rejects.toThrow('Service Unavailable');
  });
});

describe('timestamp formatting', () => {
  // The API reports seconds; the UI formats them as dates. Reading them as
  // milliseconds would render every timestamp as 1970.
  const secondsAgo = (seconds: number): number => Math.floor(Date.now() / 1000) - seconds;

  it('reports an absent timestamp as never', () => {
    expect(formatTimestamp(null)).toBe('Never');
    expect(formatTimestamp(undefined)).toBe('Never');
    expect(formatExpiryTimestamp(null)).toBe('Never');
  });

  it('describes a just-now timestamp in seconds', () => {
    expect(formatTimestamp(secondsAgo(5))).toBe('Just now');
  });

  it('scales the unit with the elapsed time', () => {
    expect(formatTimestamp(secondsAgo(5 * 60))).toBe('5m ago');
    expect(formatTimestamp(secondsAgo(3 * 3600))).toBe('3h ago');
    expect(formatTimestamp(secondsAgo(2 * 86400))).toBe('2d ago');
  });

  /**
   * The "expires soon" comparison is `diffMins < 1`, and a past timestamp has a
   * negative `diffMins` -- so an already-expired credential matched it and was
   * reported as expiring shortly. A user checking whether a credential still
   * works is told the opposite of the truth.
   */
  it('reports an elapsed expiry as expired, not as expiring soon', () => {
    expect(formatExpiryTimestamp(secondsAgo(60))).toBe('Expired');
    expect(formatExpiryTimestamp(secondsAgo(2 * 3600))).toBe('Expired');
    expect(formatExpiryTimestamp(secondsAgo(30 * 86400))).toBe('Expired');
  });

  it('counts a future expiry down to the nearest unit', () => {
    // A minute is added to each bound so the value cannot round down across the
    // threshold while the test is running.
    const inFuture = (seconds: number): number => Math.floor(Date.now() / 1000) + seconds;

    expect(formatExpiryTimestamp(inFuture(30))).toBe('Expires soon');
    expect(formatExpiryTimestamp(inFuture(10 * 60 + 30))).toBe('Expires in 10m');
    expect(formatExpiryTimestamp(inFuture(5 * 3600 + 60))).toBe('Expires in 5h');
    expect(formatExpiryTimestamp(inFuture(3 * 86400 + 60))).toBe('Expires in 3d');
  });
});
