import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { CalDavBridgeWorker } from '@/workers';
import { SPA_HTML } from '@/generated/spa-shell';
import { asD1Queryable } from '../helpers/d1';
import { applyMigrations } from '../helpers/migrations';

/**
 * The routes that answer before any authentication or storage exists: the two
 * redirects, the CORS preflight, and the SPA fallback's two branches.
 *
 * These are the worker's whole public surface for a client that has no session
 * yet — a CalDAV discovery request and a browser's first load — and each is a
 * route handler that must answer correctly with an empty environment. The
 * authenticated routes are covered by the service suites through the
 * middleware; what is pinned here is that nothing between the edge and those
 * handlers swallows a request.
 */
describe('CalDavBridgeWorker discovery routes', () => {
  it('redirects the root to the management UI', async () => {
    const response = await fetchWorker(new Request('https://bridge.example.test/'));

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/user/');
  });

  it('answers the well-known CalDAV path with a permanent redirect into the DAV root', async () => {
    // 301, not 302: discovery clients cache the well-known mapping, and a
    // temporary redirect re-asks on every request for a mapping that never
    // changes.
    const response = await fetchWorker(new Request('https://bridge.example.test/.well-known/caldav'));

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/dav/');
  });

  it('answers a CORS preflight on the user routes without a session', async () => {
    const response = await fetchWorker(
      new Request('https://bridge.example.test/user/me', {
        method: 'OPTIONS',
        headers: { Origin: 'https://bridge.example.test', 'Access-Control-Request-Method': 'GET' },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });

  it('serves the SPA shell from the worker when that is configured', async () => {
    // The two-branch fallback: the worker is the SPA's origin on a zone where
    // Pages is not, and the other branch (a 404) is the default. Both are the
    // same route — only the configuration decides which one a user sees.
    // The bypass is what makes the fallback reachable here: the route sits
    // behind `userAuthentication`, and without a session the challenge comes
    // first. A real browser always has one.
    const response = await fetchWorker(new Request('https://bridge.example.test/user/nothing-here'), {
      DEV_AUTH_EMAIL: 'dev@example.test',
      SERVE_SPA_FROM_WORKER: 'true',
    } as unknown as Env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    await expect(response.text()).resolves.toContain(SPA_HTML.slice(1, 200));
  });

  it('falls through to a 404 for an unknown user path when the worker does not serve the SPA', async () => {
    const response = await fetchWorker(new Request('https://bridge.example.test/user/nothing-here'), {
      DEV_AUTH_EMAIL: 'dev@example.test',
    } as unknown as Env);

    expect(response.status).toBe(404);
  });
});

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

    await new CalDavBridgeWorker().scheduled(
      scheduled,
      { CRON_TASKS: cronTasks } as unknown as Env,
      { waitUntil } as unknown as ExecutionContext,
    );

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

/**
 * A request through the worker, with the bindings a route needs.
 *
 * `DB` is a real SQLite database with the migrations applied — the dev-auth
 * bypass resolves the address to an account, so the user tables have to exist.
 * A caller that passes its own env overrides any of these.
 */
function fetchWorker(request: Request, env: Partial<Env> = {}): Promise<Response> {
  const database = new DatabaseSync(':memory:');
  applyMigrations(database);
  const bindings = { DB: asD1Queryable(database), ...env } as Env;
  return new CalDavBridgeWorker().fetch(request, bindings, {} as ExecutionContext);
}
