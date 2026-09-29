import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalDavBridgeWorker } from '@/workers';
import { CalDavUtil } from '@caldav-bridge/backend-services/calendar';
import { encryptData } from '@caldav-bridge/backend-data/crypto';
import { CalDavCredentialUtil } from '@caldav-bridge/shared/utils';
import { asD1Queryable } from '../helpers/d1';
import { applyMigrations } from '../helpers/migrations';

const APP = 'app-1';
const CAL = 'primary@example.com';
const USERNAME = 'dav-user';
const PASSWORD = 'dav-password';
const MASTER_KEY = 'conformance-test-master-key';
const COLLECTION = `/dav/calendars/${APP}/${encodeURIComponent(CAL)}/`;
const WORKER_URL = 'https://bridge.example.test';

const NS = 'xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"';

/**
 * Protocol conformance at the HTTP boundary, against the real worker.
 *
 * These are the cases where the bridge's answer was well-formed but wrong, so a
 * conforming client acted on it incorrectly: a `Depth` header that silently
 * reported less than was asked for, a sync token accepted on a collection it
 * was not issued for, an unsupported filter answered with unfiltered results.
 */
describe('DAV protocol conformance', () => {
  let database: DatabaseSync;
  let env: Env;
  let provider: ReturnType<typeof providerStub>;

  beforeEach(async () => {
    database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database);
    await seedAccount(database);
    env = workerEnv(database);
    provider = providerStub();
    vi.stubGlobal('fetch', provider.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('Depth', () => {
    it('treats an infinity request as a member listing rather than reporting nothing', async () => {
      provider.setEvents([event('provider-1')]);

      const response = await dav(env, 'PROPFIND', COLLECTION, {
        depth: 'infinity',
        body: '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
      });
      const body = await response.text();

      // Answering `0` here returned only the collection, so a client that asked
      // for its members discovered no events and showed an empty calendar with
      // nothing to indicate why.
      expect(body).toContain('provider-1.ics');
    });

    it('treats a depth-zero request as the collection alone', async () => {
      provider.setEvents([event('provider-1')]);

      const response = await dav(env, 'PROPFIND', COLLECTION, { depth: '0', body: '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>' });

      expect(await response.text()).not.toContain('provider-1.ics');
    });
  });

  describe('sync tokens', () => {
    it('refuses a token issued for a different collection', async () => {
      provider.setEvents([event('provider-1')]);
      const foreign = CalDavUtil.syncToken(APP, 'some-other-calendar', 5);

      const response = await dav(env, 'REPORT', COLLECTION, { body: syncCollection(foreign) });

      // Accepted before: only the trailing integer was read, so a token could
      // jump the cursor and skip changes.
      expect(response.status).toBe(403);
      expect(await response.text()).toContain('<D:valid-sync-token/>');
    });

    it('refuses a corrupt token rather than answering as though it were a fresh sync', async () => {
      provider.setEvents([event('provider-1')]);

      const response = await dav(env, 'REPORT', COLLECTION, { body: syncCollection('not-a-real-token') });

      expect(response.status).toBe(403);
      expect(await response.text()).toContain('<D:valid-sync-token/>');
    });

    it('treats an empty token as the start of a sync', async () => {
      provider.setEvents([event('provider-1')]);

      const response = await dav(env, 'REPORT', COLLECTION, { body: syncCollection(undefined) });

      expect(response.status).toBe(207);
      expect(await response.text()).toContain('provider-1.ics');
    });
  });

  describe('unsupported reports and filters', () => {
    it('reports an unknown report type as unimplemented', async () => {
      const response = await dav(env, 'REPORT', COLLECTION, { body: '<D:principal-search xmlns:D="DAV:"/>' });

      // `400` tells the client its body was malformed, sending it looking for a
      // syntax error in a request the server simply does not implement.
      expect(response.status).toBe(501);
    });

    it('refuses a filter it cannot evaluate instead of returning unfiltered results', async () => {
      provider.setEvents([event('provider-1')]);

      const response = await dav(env, 'REPORT', COLLECTION, {
        body: `<C:calendar-query ${NS}><D:prop><D:getetag/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:text-match collation="i">needle</C:text-match></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`,
      });

      // Returning every event would be a confident wrong answer: the client
      // cannot tell that the ones not matching its filter are missing.
      expect(response.status).toBe(403);
      expect(await response.text()).toContain('<C:valid-filter/>');
    });
  });

  describe('conditional writes', () => {
    it('rejects a PUT whose If-Match does not match, using strong comparison', async () => {
      provider.setEvents([event('provider-1')]);
      await dav(env, 'REPORT', COLLECTION, { body: syncCollection(undefined) });

      const response = await dav(env, 'PUT', `${COLLECTION}provider-1.ics`, {
        body: validIcs(),
        headers: { 'If-Match': 'W/"not-the-current-etag"' },
      });

      expect(response.status).toBe(412);
    });

    it('creates an object when no precondition is supplied', async () => {
      provider.setEvents([]);

      const response = await dav(env, 'PUT', `${COLLECTION}new.ics`, { body: validIcs() });

      expect(response.status).toBe(201);
    });

    it('does not write through a PUT with a mismatched media type', async () => {
      provider.setEvents([]);
      const before = provider.writeCount();

      const response = await dav(env, 'PUT', `${COLLECTION}new.ics`, {
        body: validIcs(),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(415);
      // The body was about to become a real event in the user's calendar.
      expect(provider.writeCount()).toBe(before);
    });

    it('does not write through a PUT of a body with no event in it', async () => {
      provider.setEvents([]);
      const before = provider.writeCount();

      const response = await dav(env, 'PUT', `${COLLECTION}new.ics`, { body: 'not a calendar' });

      expect(response.status).toBe(400);
      expect(provider.writeCount()).toBe(before);
    });
  });

  describe('delete', () => {
    it('reports a missing object as not found rather than succeeding', async () => {
      provider.setEvents([]);

      const response = await dav(env, 'DELETE', `${COLLECTION}absent.ics`);

      // `204` claimed a deletion that had not happened, and derived a provider
      // id from the client-supplied href to act on.
      expect(response.status).toBe(404);
    });

    it('deletes an object it holds a mapping for', async () => {
      provider.setEvents([event('provider-1')]);
      await dav(env, 'REPORT', COLLECTION, { body: syncCollection(undefined) });

      const response = await dav(env, 'DELETE', `${COLLECTION}provider-1.ics`);

      expect(response.status).toBe(204);
    });
  });

  describe('bounded work', () => {
    it('caps the hrefs answered by one multiget', async () => {
      provider.setEvents([]);
      const hrefs = Array.from(
        { length: 600 },
        (_, index) => `<D:href>/dav/calendars/${APP}/${encodeURIComponent(CAL)}/event-${index}.ics</D:href>`,
      ).join('');

      const response = await dav(env, 'REPORT', COLLECTION, {
        body: `<C:calendar-multiget ${NS}><D:prop><D:getetag/></D:prop>${hrefs}</C:calendar-multiget>`,
      });
      const body = await response.text();

      expect(response.status).toBe(207);
      // Each href costs a provider round-trip, so an uncapped list let one
      // request drive unbounded serial calls.
      expect(body.match(/<D:response>/g)?.length).toBeLessThanOrEqual(256);
    });
  });
});

async function dav(
  env: Env,
  method: string,
  path: string,
  options: { body?: string; depth?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers({ Authorization: `Basic ${btoa(`${USERNAME}:${PASSWORD}`)}`, ...(options.headers ?? {}) });
  if (options.depth) headers.set('Depth', options.depth);
  // A `PUT` with no explicit type is a calendar object; the media-type check
  // exists to reject a body that says it is something else.
  if (method === 'PUT' && !headers.has('Content-Type')) headers.set('Content-Type', 'text/calendar');
  return new CalDavBridgeWorker().fetch(
    new Request(`${WORKER_URL}${path}`, { method, headers, body: options.body }),
    env,
    {} as ExecutionContext,
  );
}

/**
 * A `sync-collection` body.
 *
 * The token is a direct child of `<D:sync>`, per RFC 4791 §7.2. An empty element
 * is the conventional "I have no state" marker, which parses to an absent token
 * and so begins a sync.
 */
function syncCollection(syncToken?: string): string {
  const token = syncToken === undefined ? '<D:sync-token/>' : `<D:sync-token>${syncToken}</D:sync-token>`;
  return `<D:sync-collection xmlns:D="DAV:"><D:sync>${token}</D:sync><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>`;
}

function validIcs(): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:new-event@example.com',
    'DTSTART:20260501T100000Z',
    'DTEND:20260501T110000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

interface StubEvent {
  id: string;
  uid: string;
  etag: string;
}

function event(id: string): StubEvent {
  return { id, uid: `${id}@example.com`, etag: `etag-${id}` };
}

/** A provider double that records writes, so "nothing reached the calendar" is assertable. */
function providerStub(): { fetch: typeof fetch; setEvents: (events: StubEvent[]) => void; writeCount: () => number } {
  let events: StubEvent[] = [];
  let writes = 0;

  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'www.googleapis.com') return json({});
    if (init?.method === 'POST' || init?.method === 'PUT' || init?.method === 'PATCH') writes += 1;
    if (url.pathname.endsWith('/calendarList')) {
      return json({ items: [{ id: CAL, summary: 'Primary', accessRole: 'owner', etag: 'cal-etag' }] });
    }
    if (url.pathname.endsWith('/events')) {
      return json({ items: events.map(googleEvent) });
    }
    if (url.pathname.includes('/events/')) {
      const id = decodeURIComponent(url.pathname.split('/events/')[1] as string);
      const found = events.find((entry) => entry.id === id);
      if (!found) return new Response('{}', { status: 404 });
      return json(googleEvent(found));
    }
    return json({ items: events.map(googleEvent) });
  }) as typeof fetch;

  return {
    fetch: fetchStub,
    setEvents: (next) => {
      events = next;
    },
    writeCount: () => writes,
  };
}

function googleEvent(entry: StubEvent): Record<string, unknown> {
  return {
    id: entry.id,
    iCalUID: entry.uid,
    etag: entry.etag,
    summary: entry.uid,
    start: { dateTime: '2026-05-01T10:00:00Z' },
    end: { dateTime: '2026-05-01T11:00:00Z' },
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function seedAccount(database: DatabaseSync): Promise<void> {
  const passwordHash = await CalDavCredentialUtil.hashPassword(PASSWORD);
  const encrypted = await encryptData(
    JSON.stringify({ clientId: 'client-id', clientSecret: 'secret', refreshToken: 'refresh' }),
    MASTER_KEY,
  );
  database
    .prepare('INSERT INTO users (email, created_at, updated_at, user_id, current_email) VALUES (?, ?, ?, ?, ?)')
    .run('owner@example.com', 100, 100, 'user-1', 'owner@example.com');
  database
    .prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 1, ?)')
    .run('owner@example.com', 'user-1', 100);
  database
    .prepare(
      `INSERT INTO connected_applications
        (application_id, user_email, user_id, display_name, provider_id, connection_method,
         encrypted_credentials, credentials_iv, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'google-calendar', 'oauth2', ?, ?, 'connected', 100, 100)`,
    )
    .run(APP, 'owner@example.com', 'user-1', 'Test Application', encrypted.encrypted, encrypted.iv);
  database
    .prepare(
      `INSERT INTO caldav_credentials
        (credential_id, application_id, username, password_hash, name, password_prefix, password_last_four, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('credential-1', APP, USERNAME, passwordHash, 'Credential', 'dav', 'word', 100, 4_102_444_800);
}

function workerEnv(database: DatabaseSync): Env {
  return {
    DB: asD1Queryable(database),
    AES_ENCRYPTION_KEY_SECRET: { get: async () => MASTER_KEY },
    OAUTH2_TOKEN_CACHE: { get: async () => 'cached-access-token', put: async () => undefined } as unknown as KVNamespace,
  } as unknown as Env;
}
