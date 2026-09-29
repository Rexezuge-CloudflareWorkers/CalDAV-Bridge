import { describe, expect, it } from 'vitest';
import { CalDavUtil } from '@caldav-bridge/backend-services/calendar';
import { BadRequestError } from '@caldav-bridge/backend-errors';

describe('CalDavUtil', () => {
  it('parses DAV resource paths', () => {
    expect(CalDavUtil.parsePath('/dav/')).toEqual({ resource: 'root' });
    expect(CalDavUtil.parsePath('/dav/principals/app-1/')).toEqual({ resource: 'principal', applicationId: 'app-1' });
    expect(CalDavUtil.parsePath('/dav/calendars/app-1/')).toEqual({ resource: 'calendarHome', applicationId: 'app-1' });
    expect(CalDavUtil.parsePath('/dav/calendars/app-1/cal%40example.com/')).toEqual({
      resource: 'calendar',
      applicationId: 'app-1',
      calendarId: 'cal@example.com',
    });
    expect(CalDavUtil.parsePath('/dav/calendars/app-1/cal%40example.com/event.ics')).toEqual({
      resource: 'object',
      applicationId: 'app-1',
      calendarId: 'cal@example.com',
      objectHref: 'event.ics',
    });
    expect(CalDavUtil.parsePath('/dav/calendars/app-1/cal-1/nested%2Fevent.ics')).toEqual({
      resource: 'object',
      applicationId: 'app-1',
      calendarId: 'cal-1',
      objectHref: 'nested/event.ics',
    });
    expect(CalDavUtil.parsePath('/not-dav/')).toEqual({ resource: 'unknown' });
  });

  it('normalizes object hrefs from absolute, collection-relative, and encoded DAV hrefs', () => {
    expect(CalDavUtil.objectHrefFromDavHref('https://example.test/dav/calendars/app-1/cal-1/nested%2Fevent.ics', 'app-1', 'cal-1')).toBe(
      'nested/event.ics',
    );
    expect(CalDavUtil.objectHrefFromDavHref('/dav/calendars/app-1/cal-1/event.ics', 'app-1', 'cal-1')).toBe('event.ics');
    expect(CalDavUtil.objectHrefFromDavHref('nested%2Fevent.ics', 'app-1', 'cal-1')).toBe('nested/event.ics');
    expect(CalDavUtil.objectHrefFromDavHref('/dav/calendars/app-2/cal-1/event.ics', 'app-1', 'cal-1')).toBeUndefined();
  });

  it('builds escaped collection and object hrefs', () => {
    expect(CalDavUtil.calendarHref('app 1', 'cal@example.com')).toBe('/dav/calendars/app%201/cal%40example.com/');
    expect(CalDavUtil.objectHref('app 1', 'cal@example.com', 'nested/event.ics')).toBe(
      '/dav/calendars/app%201/cal%40example.com/nested%2Fevent.ics',
    );
  });

  it('parses propfind modes, direct child properties, and Depth headers', () => {
    expect(CalDavUtil.parsePropfind('')).toEqual({ mode: 'allprop', properties: [] });
    expect(CalDavUtil.parsePropfind('<D:propfind xmlns:D="DAV:"><D:propname/></D:propfind>')).toEqual({ mode: 'propname', properties: [] });
    // RFC 4918 §9.1 allows refusing `infinity`, but then as `1`. Answering `0`
    // silently under-reports: a client that asked for a collection's members and
    // received only the collection discovers no events, and shows an empty
    // calendar with nothing to indicate why.
    expect(CalDavUtil.parseDepth('infinity')).toBe(1);
    expect(CalDavUtil.parseDepth(' 1 ')).toBe(1);
    expect(CalDavUtil.parseDepth('INFINITY')).toBe(1);
    expect(CalDavUtil.parseDepth('0')).toBe(0);
    expect(CalDavUtil.parseDepth(null)).toBe(0);
    expect(
      CalDavUtil.parsePropfind(
        '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data><C:expand/></C:calendar-data><D:getetag/></D:prop></D:propfind>',
      ),
    ).toEqual({ mode: 'prop', properties: ['getetag', 'calendar-data'] });
  });

  it('returns current principal and calendar home discovery properties', async () => {
    const root = await CalDavUtil.propfindRoot(
      'app-1',
      CalDavUtil.parsePropfind('<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/><D:principal-URL/></D:prop></D:propfind>'),
    ).text();
    expect(root).toContain('<D:current-user-principal><D:href>/dav/principals/app-1/</D:href></D:current-user-principal>');
    expect(root).toContain('<D:principal-URL><D:href>/dav/principals/app-1/</D:href></D:principal-URL>');

    const principal = await CalDavUtil.propfindPrincipal(
      'app-1',
      CalDavUtil.parsePropfind(
        '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><C:calendar-home-set/></D:prop></D:propfind>',
      ),
    ).text();
    expect(principal).toContain('<C:calendar-home-set><D:href>/dav/calendars/app-1/</D:href></C:calendar-home-set>');
  });

  it('returns calendar collections for depth-one calendar-home PROPFIND', async () => {
    const response = await CalDavUtil.propfindCalendarHome(
      'app-1',
      [{ id: 'work@example.com', name: 'Work', timeZone: 'UTC', etag: 'calendar-etag' }],
      CalDavUtil.parsePropfind('<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>'),
      1,
    ).text();

    expect(response).toContain('<D:href>/dav/calendars/app-1/</D:href>');
    expect(response).toContain('<D:href>/dav/calendars/app-1/work%40example.com/</D:href>');
    expect(response).toContain('<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>');
    expect(response).toContain('<D:supported-report-set><D:supported-report><D:report><C:calendar-query/></D:report></D:supported-report>');
    expect(response).toContain('<D:report><D:sync-collection/></D:report>');
  });

  it('returns object metadata for depth-one calendar PROPFIND', async () => {
    const response = await CalDavUtil.propfindCalendar(
      'app-1',
      { id: 'cal-1', name: 'Calendar' },
      CalDavUtil.parsePropfind('<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>'),
      1,
      [
        {
          href: 'provider-id.ics',
          event: {
            id: 'provider/id',
            uid: 'event-1@example.com',
            etag: 'etag-1',
            summary: 'Planning',
            start: { dateTime: '2026-05-21T10:00:00Z' },
            end: { dateTime: '2026-05-21T11:00:00Z' },
            updated: '2026-05-21T09:00:00Z',
          },
        },
      ],
    ).text();

    expect(response).toContain('<D:href>/dav/calendars/app-1/cal-1/provider-id.ics</D:href>');
    expect(response).toContain('<D:getetag>&quot;etag-1&quot;</D:getetag>');
    expect(response).toContain('<D:getcontenttype>text/calendar; charset=utf-8</D:getcontenttype>');
    expect(response).toContain('<D:getlastmodified>Thu, 21 May 2026 09:00:00 GMT</D:getlastmodified>');
  });

  /**
   * `getctag` is compared for equality, never parsed. Deriving it from the
   * collection's highest sync version is therefore equivalent to hashing every
   * object tag, and bounded -- the previous form concatenated a tag for every
   * live object and every retained tombstone, so the value grew without limit
   * and was re-serialised into every depth-one PROPFIND.
   */
  it('derives calendar getctag from the highest sync version', async () => {
    const request = CalDavUtil.parsePropfind(
      '<D:propfind xmlns:D="DAV:" xmlns:CS="http://calendarserver.org/ns/"><D:prop><CS:getctag/></D:prop></D:propfind>',
    );
    const calendar = { id: 'cal-1', name: 'Calendar', etag: 'calendar-etag' };

    const first = await CalDavUtil.propfindCalendar('app-1', calendar, request, 0, [{ href: 'event-1.ics', syncVersion: 4 }]).text();
    const second = await CalDavUtil.propfindCalendar('app-1', calendar, request, 0, [{ href: 'event-1.ics', syncVersion: 7 }]).text();
    const unchanged = await CalDavUtil.propfindCalendar('app-1', calendar, request, 0, [
      { href: 'event-1.ics', syncVersion: 4 },
      { href: 'event-2.ics', syncVersion: 4 },
    ]).text();

    expect(first).toContain('<CS:getctag>app-1:cal-1:calendar-etag:4</CS:getctag>');
    expect(second).toContain('<CS:getctag>app-1:cal-1:calendar-etag:7</CS:getctag>');
    // A new object at the same version does not change the tag, which is
    // correct: nothing about the collection's state changed.
    expect(unchanged).toContain('<CS:getctag>app-1:cal-1:calendar-etag:4</CS:getctag>');
  });

  it('derives calendar getctag including tombstones', async () => {
    const request = CalDavUtil.parsePropfind(
      '<D:propfind xmlns:D="DAV:" xmlns:CS="http://calendarserver.org/ns/"><D:prop><CS:getctag/></D:prop></D:propfind>',
    );
    const response = await CalDavUtil.propfindCalendar('app-1', { id: 'cal-1', name: 'Calendar', etag: 'calendar-etag' }, request, 0, [
      { href: 'event-1.ics', status: 404, syncVersion: 9 },
    ]).text();

    expect(response).toContain('<CS:getctag>app-1:cal-1:calendar-etag:9</CS:getctag>');
  });

  it('returns sync-token on calendar PROPFIND', async () => {
    const request = CalDavUtil.parsePropfind('<D:propfind xmlns:D="DAV:"><D:prop><D:sync-token/></D:prop></D:propfind>');
    const response = await CalDavUtil.propfindCalendar(
      'app-1',
      { id: 'cal-1', name: 'Calendar' },
      request,
      0,
      [],
      CalDavUtil.syncToken('app-1', 'cal-1', 3),
    ).text();

    expect(response).toContain('<D:sync-token>caldav-bridge:app-1:cal-1:3</D:sync-token>');
  });

  it('reports unknown requested properties in a 404 propstat', async () => {
    const response = await CalDavUtil.propfindCalendar(
      'app-1',
      { id: 'cal-1', name: 'Calendar' },
      CalDavUtil.parsePropfind('<D:propfind xmlns:D="DAV:"><D:prop><D:displayname/><D:not-real/></D:prop></D:propfind>'),
      0,
    ).text();

    expect(response).toContain('<D:displayname>Calendar</D:displayname>');
    expect(response).toContain('<D:not-real/>');
    expect(response).toContain('<D:status>HTTP/1.1 404 Not Found</D:status>');
  });

  it('parses calendar reports', () => {
    const multiget = CalDavUtil.parseReport(
      '<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop><D:href>/dav/calendars/app-1/cal-1/event.ics</D:href></C:calendar-multiget>',
    );
    expect(multiget.type).toBe('calendar-multiget');
    expect(multiget.properties).toEqual(['getetag', 'calendar-data']);
    expect(multiget.hrefs).toEqual(['/dav/calendars/app-1/cal-1/event.ics']);

    const query = CalDavUtil.parseReport(
      '<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="20260501T000000Z" end="20260601T000000Z"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>',
    );
    expect(query.type).toBe('calendar-query');
    expect(query.timeRange).toEqual({ start: '2026-05-01T00:00:00Z', end: '2026-06-01T00:00:00Z' });

    const sync = CalDavUtil.parseReport(
      '<D:sync-collection xmlns:D="DAV:"><D:sync-token>caldav-bridge:app-1:cal-1:2</D:sync-token><D:prop><D:getetag/></D:prop></D:sync-collection>',
    );
    expect(sync.type).toBe('sync-collection');
    expect(sync.syncToken).toBe('caldav-bridge:app-1:cal-1:2');
    expect(CalDavUtil.parseSyncToken(sync.syncToken, 'app-1', 'cal-1')).toEqual({ version: 2 });

    // The token under `<D:sync>`, where RFC 4791 §7.2 places it.
    const wrapped = CalDavUtil.parseReport(
      '<D:sync-collection xmlns:D="DAV:"><D:sync><D:sync-token>caldav-bridge:app-1:cal-1:3</D:sync-token></D:sync><D:prop><D:getetag/></D:prop></D:sync-collection>',
    );
    expect(wrapped.syncToken).toBe('caldav-bridge:app-1:cal-1:3');
  });

  it('reads the request sync token only from a direct child, never from a property', () => {
    // A `sync-token` requested inside `<D:prop>` is a property to be returned,
    // not the client's position. Reading it as the position would restart the
    // client from a version it never held.
    const report = CalDavUtil.parseReport(
      '<D:sync-collection xmlns:D="DAV:"><D:prop><D:sync-token/><D:getetag/></D:prop></D:sync-collection>',
    );
    expect(report.syncToken).toBeUndefined();
  });

  describe('sync token validation', () => {
    it('accepts an absent token, which is how a client starts a sync', () => {
      expect(CalDavUtil.parseSyncToken(undefined, 'app-1', 'cal-1')).toEqual({ version: 0 });
      expect(CalDavUtil.parseSyncToken('', 'app-1', 'cal-1')).toEqual({ version: 0 });
    });

    it('accepts its own token for the collection that issued it', () => {
      const token = CalDavUtil.syncToken('app-1', 'cal-1', 7);
      expect(CalDavUtil.parseSyncToken(token, 'app-1', 'cal-1')).toEqual({ version: 7 });
    });

    // Only the trailing integer used to be read, so a token from one collection
    // was accepted on another and could jump the cursor, skipping changes.
    it('rejects a token issued for a different collection', () => {
      const token = CalDavUtil.syncToken('app-1', 'cal-1', 9);
      expect(CalDavUtil.parseSyncToken(token, 'app-1', 'cal-2')).toEqual({ invalid: true });
      expect(CalDavUtil.parseSyncToken(token, 'app-2', 'cal-1')).toEqual({ invalid: true });
    });

    it('rejects a corrupt or foreign token', () => {
      for (const token of [
        'abc',
        'caldav-bridge:app-1:cal-1',
        'caldav-bridge:app-1:cal-1:x',
        'other:app-1:cal-1:2',
        'caldav-bridge::cal-1:2',
        'caldav-bridge:app-1:cal-1:2:extra',
      ]) {
        expect(CalDavUtil.parseSyncToken(token, 'app-1', 'cal-1')).toEqual({ invalid: true });
      }
    });
  });

  describe('query filter handling', () => {
    it('accepts the filter shape it can evaluate', () => {
      const report = CalDavUtil.parseReport(
        '<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter></C:calendar-query>',
      );
      expect(report.unsupportedFilter).toBeUndefined();
    });

    // Silently dropping an unevaluable filter means returning events that do not
    // match what the client asked for, which RFC 4791 §7.8 forbids and the
    // client cannot detect.
    it.each([
      ['<C:comp-filter name="VTODO"><C:comp-filter name="VTODO"/></C:comp-filter>'],
      ['<C:comp-filter name="VCALENDAR"><C:comp-filter name="VALARM"/></C:comp-filter>'],
      [
        '<C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="20260501T000000Z"/><C:text-match collation="i">x</C:text-match></C:comp-filter></C:comp-filter>',
      ],
    ])('reports %s as unevaluable', (filter) => {
      const report = CalDavUtil.parseReport(
        `<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"><C:filter>${filter}</C:filter></C:calendar-query>`,
      );
      expect(report.unsupportedFilter).toBeTruthy();
    });
  });

  describe('time-range validation', () => {
    it('normalises date and date-time bounds to ISO instants', () => {
      const report = CalDavUtil.parseReport(
        '<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="20260501" end="20260601T120000Z"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>',
      );
      expect(report.timeRange).toEqual({ start: '2026-05-01T00:00:00Z', end: '2026-06-01T12:00:00Z' });
    });

    // An unparseable bound became ±Infinity, so a bounded query silently
    // returned the whole calendar.
    it('rejects an unparseable or inverted range', () => {
      for (const range of [
        '<C:time-range start="not-a-date"/>',
        '<C:time-range end="20261345T000000Z"/>',
        '<C:time-range start="20260601T000000Z" end="20260501T000000Z"/>',
      ]) {
        const body = `<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">${range}</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`;
        expect(() => CalDavUtil.parseReport(body)).toThrow(BadRequestError);
      }
    });
  });

  it('returns quoted etags and calendar data in object reports', async () => {
    const response = await CalDavUtil.calendarObjectReport(
      'app-1',
      'cal-1',
      [
        {
          href: 'event.ics',
          event: {
            uid: 'event-1@example.com',
            etag: 'etag-1',
            summary: 'Planning',
            start: { dateTime: '2026-05-21T10:00:00Z' },
            end: { dateTime: '2026-05-21T11:00:00Z' },
          },
        },
      ],
      ['getetag', 'calendar-data'],
    ).text();

    expect(response).toContain('<D:getetag>&quot;etag-1&quot;</D:getetag>');
    expect(response).toContain('<C:calendar-data>BEGIN:VCALENDAR');
    expect(response).toContain('SUMMARY:Planning');
  });

  it('returns 404 responses for missing calendar-multiget objects', async () => {
    const response = await CalDavUtil.calendarObjectReport(
      'app-1',
      'cal-1',
      [{ href: 'missing.ics', status: 404 }],
      ['getetag', 'calendar-data'],
    ).text();

    expect(response).toContain('<D:href>/dav/calendars/app-1/cal-1/missing.ics</D:href>');
    expect(response).toContain('<D:status>HTTP/1.1 404 Not Found</D:status>');
  });

  it('returns sync-collection tombstones and the next sync token', async () => {
    const response = await CalDavUtil.syncCollectionReport(
      'app-1',
      'cal-1',
      [{ href: 'deleted.ics', status: 404, syncVersion: 4 }],
      ['getetag', 'calendar-data'],
      CalDavUtil.syncToken('app-1', 'cal-1', 4),
    ).text();

    expect(response).toContain('<D:href>/dav/calendars/app-1/cal-1/deleted.ics</D:href>');
    expect(response).toContain('<D:status>HTTP/1.1 404 Not Found</D:status>');
    expect(response).toContain('<D:sync-token>caldav-bridge:app-1:cal-1:4</D:sync-token>');
  });

  it('escapes iCalendar data safely when embedding it in DAV XML', async () => {
    const response = await CalDavUtil.calendarObjectReport(
      'app-1',
      'cal-1',
      [
        {
          href: 'event.ics',
          event: {
            uid: 'event-1@example.com',
            summary: 'A & B < C',
            description: '<html>\r\n<body>One; Two & Three</body>\r\n</html>',
            start: { dateTime: '2026-05-21T10:00:00Z' },
            end: { dateTime: '2026-05-21T11:00:00Z' },
          },
        },
      ],
      ['calendar-data'],
    ).text();

    expect(response).toContain('SUMMARY:A &amp; B &lt; C');
    expect(response).toContain('DESCRIPTION:&lt;html&gt;\\n&lt;body&gt;One\\; Two &amp; Three&lt;/body&gt;\\n&lt;/html&gt;');
  });

  it('matches conditional etag headers', () => {
    expect(CalDavUtil.etagMatches('"etag-1"', 'etag-1')).toBe(true);
    expect(CalDavUtil.etagMatches('"etag-1", "etag-2"', 'etag-2')).toBe(true);
    expect(CalDavUtil.etagMatches('"etag-1"', 'etag-2')).toBe(false);
    expect(CalDavUtil.etagMatches('*', 'etag-2')).toBe(true);
    expect(CalDavUtil.etagMatches('*')).toBe(false);
  });

  it('returns calendar and error response headers', async () => {
    const calendar = CalDavUtil.textCalendarResponse('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', 'etag-1');
    expect(calendar.headers.get('Content-Type')).toBe('text/calendar; charset=utf-8');
    expect(calendar.headers.get('ETag')).toBe('"etag-1"');
    expect(await calendar.text()).toBe('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');

    const error = CalDavUtil.davError(405, 'Nope');
    expect(error.headers.get('Allow')).toBe('OPTIONS, PROPFIND, REPORT, GET, HEAD, PUT, DELETE');
    expect(await error.text()).toContain('<D:responsedescription>Nope</D:responsedescription>');
  });

  it('returns a Basic challenge for DAV auth errors', () => {
    const response = CalDavUtil.davError(401, 'Valid CalDAV credentials are required.');
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="CalDAV Bridge", charset="UTF-8"');
  });
});
