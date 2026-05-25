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

describe('CalDavBridgeWorker scheduled tasks', () => {
  it('delegates scheduled events to the singleton cron tasks durable object', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'completed' })));
    const cronTasks = {
      idFromName: vi.fn(() => 'cron-tasks-id'),
      get: vi.fn(() => ({ fetch })),
    };
    const waitUntil = vi.fn();
    const scheduled = {
      cron: '0 4 * * *',
      scheduledTime: 123456,
      noRetry: vi.fn(),
    } as ScheduledController;

    await new CalDavBridgeWorker().scheduled(scheduled, { CRON_TASKS: cronTasks } as unknown as Env, { waitUntil } as unknown as ExecutionContext);

    expect(cronTasks.idFromName).toHaveBeenCalledWith('global');
    expect(cronTasks.get).toHaveBeenCalledWith('cron-tasks-id');
    expect(waitUntil).toHaveBeenCalledOnce();
    await waitUntil.mock.calls[0][0];
    expect(fetch).toHaveBeenCalledOnce();
    const request = fetch.mock.calls[0][0] as Request;
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe('/run');
    await expect(request.json()).resolves.toEqual({ cron: '0 4 * * *', scheduledTime: 123456 });
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
