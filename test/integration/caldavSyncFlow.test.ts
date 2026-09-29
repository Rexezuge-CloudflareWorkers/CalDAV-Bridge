import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalDavBridgeWorker } from '@/workers';
import { CalendarObjectMappingDAO } from '@caldav-bridge/backend-data/dao';
import { encryptData } from '@caldav-bridge/backend-data/crypto';
import { DavPathUtil } from '@caldav-bridge/backend-services/calendar';
import { CalDavCredentialUtil } from '@caldav-bridge/shared/utils';
import { asD1Queryable } from '../helpers/d1';
import { applyMigrations } from '../helpers/migrations';

const APP = 'app-1';
const CAL = 'primary@example.com';
const USERNAME = 'dav-user';
const PASSWORD = 'dav-password';

const COLLECTION = `/dav/calendars/${APP}/${encodeURIComponent(CAL)}/`;
const WORKER_URL = 'https://bridge.example.test';

describe('CalDAV sync round trip', () => {
  let database: DatabaseSync;
  let env: Env;

  beforeEach(async () => {
    database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database);
    await seedAccount(database);
    env = workerEnv(database);
    setProviderEvents([]);
    vi.stubGlobal('fetch', providerFetchStub());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * The invariant this whole flow exists to protect: a client that holds a sync
   * token is guaranteed to be sent every change made after it, and none of them
   * twice. When it was broken, `listChangedSince` and `getMaxSyncVersion` were
   * two unsynchronised reads, so a write landing between them was assigned a
   * version at or below the token just handed out while being absent from the
   * results. The next request asks for `> token`, so that object was never sent
   * again -- permanent, unrecoverable divergence.
   */
  const REPORT = (body: string): Promise<Response> => davRequest(env, 'REPORT', COLLECTION, { body });

  it('never loses a change made after a client was last served', async () => {
    setProviderEvents([event('provider-1', 'one'), event('provider-2', 'two')]);

    // First sync: the client learns the collection.
    const initial = await REPORT(syncCollectionBody());
    const initialBody = await initial.text();
    const firstToken = tokenFrom(initialBody);
    expect(firstToken).toBeTruthy();
    expect(hrefsIn(initialBody)).toEqual(['provider-1.ics', 'provider-2.ics']);

    // An event disappears upstream. Its tombstone is reported once.
    setProviderEvents([event('provider-1', 'one'), event('provider-2', 'two'), event('provider-3', 'three')]);
    const addition = await REPORT(syncCollectionBody(firstToken));
    const afterAddition = tokenFrom(await addition.text());
    expect(afterAddition).not.toBe(firstToken);

    setProviderEvents([event('provider-1', 'one'), event('provider-3', 'three')]);
    const removal = await REPORT(syncCollectionBody(afterAddition));
    const removalBody = await removal.text();
    const afterRemoval = tokenFrom(removalBody);
    expect(statusesIn(removalBody)).toEqual(['404']);

    // A change made *after* the client was served must still reach it. This is
    // the case the old read-then-read ordering lost.
    setProviderEvents([event('provider-1', 'one'), event('provider-3', 'three'), event('provider-4', 'four')]);
    const final = await REPORT(syncCollectionBody(afterRemoval));
    const finalBody = await final.text();

    expect(hrefsIn(finalBody)).toEqual(['provider-4.ics']);
    expect(tokenFrom(finalBody)).toBeTruthy();

    // And the client is now fully caught up: nothing is re-sent.
    const settled = await REPORT(syncCollectionBody(tokenFrom(finalBody)));
    expect(hrefsIn(await settled.text())).toEqual([]);
  });

  it('reports a full snapshot exactly once, not on every later request', async () => {
    setProviderEvents([event('provider-1', 'one'), event('provider-2', 'two')]);
    const first = await REPORT(calendarQueryBody());
    expect(hrefsIn(await first.text())).toEqual(['provider-1.ics', 'provider-2.ics']);

    setProviderEvents([event('provider-1', 'one')]);
    const afterRemoval = await REPORT(calendarQueryBody());
    expect(statusesIn(await afterRemoval.text())).toEqual(['404']);

    // The tombstone stays inside the retention window, but re-reporting it
    // would tell the client about a deletion it has already applied.
    const third = await REPORT(calendarQueryBody());
    const thirdBody = await third.text();
    expect(statusesIn(thirdBody)).toEqual([]);
    expect(hrefsIn(thirdBody)).toEqual(['provider-1.ics']);
  });

  it('keeps a depth-one PROPFIND token consistent with the objects it returns', async () => {
    setProviderEvents([event('provider-1', 'one')]);
    const response = await davRequest(env, 'PROPFIND', COLLECTION, { Depth: '1', body: allPropBody() });
    const body = await response.text();

    expect(response.status).toBe(207);
    // The token describes the state the objects were read at, so a client that
    // adopts it is not silently behind the collection.
    expect(tokenFrom(body)).toBe(DavPathUtil.syncToken(APP, CAL, 1));
    const sync = await REPORT(syncCollectionBody(tokenFrom(body)));
    expect(hrefsIn(await sync.text())).toEqual([]);
  });

  it('does not tombstone a calendar for a time-ranged query', async () => {
    setProviderEvents([event('provider-1', 'one'), event('provider-2', 'two')]);
    await REPORT(calendarQueryBody());

    // A bounded query legitimately returns a subset; absence means "outside the
    // window", not "deleted upstream".
    const ranged = await REPORT(
      '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="20260501T000000Z" end="20260502T000000Z"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>',
    );

    expect(ranged.status).toBe(207);
    const dao = new CalendarObjectMappingDAO(asD1Queryable(database));
    expect(await dao.listByCalendar(APP, CAL)).toHaveLength(2);
  });

  it('requires authentication before serving any calendar data', async () => {
    setProviderEvents([event('provider-1', 'one')]);

    const response = await davRequest(env, 'PROPFIND', COLLECTION, { body: allPropBody(), auth: false });

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('BEGIN:VCALENDAR');
  });
});

/**
 * Drives the real worker against the seeded database and a stubbed provider, so
 * the whole authenticated path -- credential lookup, token resolution, provider
 * fetch, mapping reconciliation, XML serialisation -- runs as it does in
 * production. `env` is threaded explicitly rather than closed over, so a test
 * cannot pass against another test's fixture by accident.
 */
async function davRequest(
  env: Env,
  method: string,
  path: string,
  options: { body?: string; depth?: string; auth?: boolean } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.auth !== false) headers.set('Authorization', `Basic ${btoa(`${USERNAME}:${PASSWORD}`)}`);
  if (options.depth) headers.set('Depth', options.depth);
  return new CalDavBridgeWorker().fetch(
    new Request(`${WORKER_URL}${path}`, { method, headers, body: options.body }),
    env,
    {} as ExecutionContext,
  );
}

function syncCollectionBody(syncToken?: string): string {
  const token = syncToken ? `<D:sync-token>${syncToken}</D:sync-token>` : '<D:sync-token/>';
  return `<D:sync-collection xmlns:D="DAV:"><D:sync>${token}</D:sync><D:sync-level>1</D:sync-level><D:prop><D:getetag/><C:calendar-data xmlns:C="urn:ietf:params:xml:ns:caldav"/></D:prop></D:sync-collection>`;
}

function calendarQueryBody(): string {
  return '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter></C:calendar-query>';
}

function allPropBody(): string {
  return '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>';
}

function tokenFrom(body: string): string {
  return /<D:sync-token>([^<]+)<\/D:sync-token>/.exec(body)?.[1] ?? '';
}

/**
 * The hrefs reported as live objects.
 *
 * Every response carries a per-property `404` propstat listing properties the
 * server could not resolve, so a response counts as an object only when it also
 * has a `200` propstat. Matching whole `<D:response>` elements keeps the two
 * apart without depending on their internal ordering.
 */
function hrefsIn(body: string): string[] {
  return responseBlocks(body)
    .filter((block) => block.includes('<D:status>HTTP/1.1 200 OK</D:status>'))
    .map((block) => /<D:href>([^<]+)<\/D:href>/.exec(block)?.[1] as string)
    .map((href) => decodeURIComponent(href.split('/').pop() as string))
    .sort();
}

/** Response-level status codes, which is how a tombstone is reported. */
function statusesIn(body: string): string[] {
  return responseBlocks(body)
    .filter((block) => !block.includes('<D:propstat>'))
    .map((block) => /<D:status>HTTP\/1\.1 (\d{3})/.exec(block)?.[1] as string)
    .sort();
}

/** The bodies of each top-level `<D:response>` element. */
function responseBlocks(body: string): string[] {
  return [...body.matchAll(/<D:response>([\s\S]*?)<\/D:response>/g)].map((match) => match[1] as string);
}

// ── Provider stub ───────────────────────────────────────────────────────────

interface StubEvent {
  id: string;
  uid: string;
  etag: string;
}

let providerEvents: StubEvent[] = [];

function setProviderEvents(events: StubEvent[]): void {
  providerEvents = events;
}

function event(id: string, slug: string): StubEvent {
  return { id, uid: `${slug}@example.com`, etag: `etag-${slug}` };
}

/** Answers the Google endpoints the DAV flow reaches, from an in-memory event list. */
function providerFetchStub(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'www.googleapis.com') return json({});
    if (url.pathname.endsWith('/calendarList')) {
      return json({ items: [{ id: CAL, summary: 'Primary', accessRole: 'owner', etag: 'cal-etag' }] });
    }
    if (url.pathname.includes('/events/')) {
      const id = decodeURIComponent(url.pathname.split('/events/')[1] as string);
      const found = providerEvents.find((entry) => entry.id === id);
      return found ? json(googleEvent(found)) : new Response('{}', { status: 404 });
    }
    return json({
      items: providerEvents.map((entry) => googleEvent(entry)),
    });
  }) as typeof fetch;
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

// ── Fixture ─────────────────────────────────────────────────────────────────

/**
 * A full account: user, application, and a CalDAV credential whose hash matches
 * the password the requests present. Written straight to SQLite so the test
 * exercises the same authentication path production does.
 */
const MASTER_KEY = 'integration-test-master-key';

/** Provider credentials, encrypted the way the application DAO stores them. */
const CREDENTIALS = { clientId: 'client-id', clientSecret: 'client-secret', refreshToken: 'refresh-token' };

async function seedAccount(database: DatabaseSync): Promise<void> {
  const passwordHash = await CalDavCredentialUtil.hashPassword(PASSWORD);
  // Real ciphertext: the authenticated path decrypts the application's stored
  // credentials to reach the provider, so a placeholder would not get this far.
  const encrypted = await encryptData(JSON.stringify(CREDENTIALS), MASTER_KEY);
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
    .run(
      'credential-1',
      APP,
      USERNAME,
      passwordHash,
      'Test Credential',
      'dav',
      'word',
      100,
      // Far enough ahead that the credential has not expired.
      4_102_444_800,
    );
}

function workerEnv(database: DatabaseSync): Env {
  return {
    DB: asD1Queryable(database),
    AES_ENCRYPTION_KEY_SECRET: { get: async () => MASTER_KEY },
    OAUTH2_TOKEN_CACHE: {
      get: async () => 'cached-access-token',
      put: async () => undefined,
    } as unknown as KVNamespace,
  } as unknown as Env;
}
