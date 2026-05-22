import { describe, expect, it, vi } from 'vitest';
import { CalDavBridgeWorker, OAuth2TokenRefreshWorker } from '@/workers';

describe('CalDavBridgeWorker DAV routing', () => {
  it('answers DAV OPTIONS without authentication', async () => {
    const response = await fetchWorker(new Request('https://bridge.example.test/dav', { method: 'OPTIONS' }));

    expect(response.status).toBe(204);
    expect(response.headers.get('DAV')).toBe('1, 3, calendar-access');
    expect(response.headers.get('Allow')).toBe('OPTIONS, PROPFIND, REPORT, GET, HEAD, PUT, DELETE');
  });

  it('returns DAV 404 XML for unknown DAV paths before authentication', async () => {
    const response = await fetchWorker(new Request('https://bridge.example.test/dav/unknown/path', { method: 'GET' }));

    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
    await expect(response.text()).resolves.toContain('<D:status>HTTP/1.1 404 Not Found</D:status>');
  });

  it('returns a Basic challenge for authenticated DAV resources without credentials', async () => {
    const response = await fetchWorker(new Request('https://bridge.example.test/dav/', { method: 'PROPFIND' }));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="CalDAV Bridge", charset="UTF-8"');
    await expect(response.text()).resolves.toContain('Valid CalDAV credentials are required.');
  });
});

function fetchWorker(request: Request): Promise<Response> {
  return new CalDavBridgeWorker().fetch(request, {} as Env, {} as ExecutionContext);
}

describe('OAuth2TokenRefreshWorker request validation', () => {
  it('rejects refresh requests without an applicationId before durable state work', async () => {
    const state = fakeDurableObjectState();
    const response = await new OAuth2TokenRefreshWorker(state, {} as Env).fetch(
      new Request('https://bridge.example.test/refresh', { method: 'POST', body: JSON.stringify({}) }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'applicationId is required.' });
    expect(state.blockConcurrencyWhile).not.toHaveBeenCalled();
  });

  it('rejects incomplete OAuth2 exchange requests before durable state work', async () => {
    const state = fakeDurableObjectState();
    const response = await new OAuth2TokenRefreshWorker(state, {} as Env).fetch(
      new Request('https://bridge.example.test/exchange', { method: 'POST', body: JSON.stringify({ applicationId: 'app-1' }) }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'OAuth2 exchange input is incomplete.' });
    expect(state.blockConcurrencyWhile).not.toHaveBeenCalled();
  });
});

function fakeDurableObjectState(): DurableObjectState & { blockConcurrencyWhile: ReturnType<typeof vi.fn> } {
  return {
    blockConcurrencyWhile: vi.fn(),
  } as unknown as DurableObjectState & { blockConcurrencyWhile: ReturnType<typeof vi.fn> };
}
