import { describe, expect, it } from 'vitest';
import { CalDavUtil } from '@/utils';

describe('CalDavUtil', () => {
  it('parses DAV resource paths', () => {
    expect(CalDavUtil.parsePath('/dav/')).toEqual({ resource: 'root' });
    expect(CalDavUtil.parsePath('/dav/principals/app-1/')).toEqual({ resource: 'principal', applicationId: 'app-1' });
    expect(CalDavUtil.parsePath('/dav/calendars/app-1/')).toEqual({ resource: 'calendarHome', applicationId: 'app-1' });
    expect(CalDavUtil.parsePath('/dav/calendars/app-1/cal%40example.com/')).toEqual({ resource: 'calendar', applicationId: 'app-1', calendarId: 'cal@example.com' });
    expect(CalDavUtil.parsePath('/dav/calendars/app-1/cal%40example.com/event.ics')).toEqual({ resource: 'object', applicationId: 'app-1', calendarId: 'cal@example.com', objectHref: 'event.ics' });
    expect(CalDavUtil.parsePath('/dav/calendars/app-1/cal-1/nested%2Fevent.ics')).toEqual({ resource: 'object', applicationId: 'app-1', calendarId: 'cal-1', objectHref: 'nested/event.ics' });
    expect(CalDavUtil.parsePath('/not-dav/')).toEqual({ resource: 'unknown' });
  });

  it('normalizes object hrefs from absolute, collection-relative, and encoded DAV hrefs', () => {
    expect(CalDavUtil.objectHrefFromDavHref('https://example.test/dav/calendars/app-1/cal-1/nested%2Fevent.ics', 'app-1', 'cal-1')).toBe('nested/event.ics');
    expect(CalDavUtil.objectHrefFromDavHref('/dav/calendars/app-1/cal-1/event.ics', 'app-1', 'cal-1')).toBe('event.ics');
    expect(CalDavUtil.objectHrefFromDavHref('nested%2Fevent.ics', 'app-1', 'cal-1')).toBe('nested/event.ics');
    expect(CalDavUtil.objectHrefFromDavHref('/dav/calendars/app-2/cal-1/event.ics', 'app-1', 'cal-1')).toBeUndefined();
  });

  it('builds escaped collection and object hrefs', () => {
    expect(CalDavUtil.calendarHref('app 1', 'cal@example.com')).toBe('/dav/calendars/app%201/cal%40example.com/');
    expect(CalDavUtil.objectHref('app 1', 'cal@example.com', 'nested/event.ics')).toBe('/dav/calendars/app%201/cal%40example.com/nested%2Fevent.ics');
  });

  it('parses propfind modes, direct child properties, and Depth headers', () => {
    expect(CalDavUtil.parsePropfind('')).toEqual({ mode: 'allprop', properties: [] });
    expect(CalDavUtil.parsePropfind('<D:propfind xmlns:D="DAV:"><D:propname/></D:propfind>')).toEqual({ mode: 'propname', properties: [] });
    expect(
      CalDavUtil.parsePropfind(
        '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data><C:expand/></C:calendar-data><D:getetag/></D:prop></D:propfind>',
      ),
    ).toEqual({ mode: 'prop', properties: ['getetag', 'calendar-data'] });
    expect(CalDavUtil.parseDepth('1')).toBe(1);
    expect(CalDavUtil.parseDepth('infinity')).toBe(0);
    expect(CalDavUtil.parseDepth(null)).toBe(0);
  });

  it('returns current principal and calendar home discovery properties', async () => {
    const root = await CalDavUtil.propfindRoot('app-1', CalDavUtil.parsePropfind('<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/><D:principal-URL/></D:prop></D:propfind>')).text();
    expect(root).toContain('<D:current-user-principal><D:href>/dav/principals/app-1/</D:href></D:current-user-principal>');
    expect(root).toContain('<D:principal-URL><D:href>/dav/principals/app-1/</D:href></D:principal-URL>');

    const principal = await CalDavUtil.propfindPrincipal('app-1', CalDavUtil.parsePropfind('<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><C:calendar-home-set/></D:prop></D:propfind>')).text();
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

  it('derives calendar getctag from object tags when available', async () => {
    const request = CalDavUtil.parsePropfind('<D:propfind xmlns:D="DAV:" xmlns:CS="http://calendarserver.org/ns/"><D:prop><CS:getctag/></D:prop></D:propfind>');
    const first = await CalDavUtil.propfindCalendar('app-1', { id: 'cal-1', name: 'Calendar', etag: 'calendar-etag' }, request, 0, [
      {
        href: 'event-1.ics',
        event: {
          id: 'event-1',
          uid: 'event-1@example.com',
          etag: 'etag-1',
          start: { dateTime: '2026-05-21T10:00:00Z' },
          end: { dateTime: '2026-05-21T11:00:00Z' },
        },
      },
    ]).text();
    const second = await CalDavUtil.propfindCalendar('app-1', { id: 'cal-1', name: 'Calendar', etag: 'calendar-etag' }, request, 0, [
      {
        href: 'event-1.ics',
        event: {
          id: 'event-1',
          uid: 'event-1@example.com',
          etag: 'etag-1',
          start: { dateTime: '2026-05-21T10:00:00Z' },
          end: { dateTime: '2026-05-21T11:00:00Z' },
        },
      },
      {
        href: 'event-2.ics',
        event: {
          id: 'event-2',
          uid: 'event-2@example.com',
          etag: 'etag-2',
          start: { dateTime: '2026-05-22T10:00:00Z' },
          end: { dateTime: '2026-05-22T11:00:00Z' },
        },
      },
    ]).text();

    expect(first).toContain('<CS:getctag>app-1:cal-1:calendar-etag:event-1.ics:etag-1</CS:getctag>');
    expect(second).toContain('event-2.ics:etag-2');
    expect(second).not.toBe(first);
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
    const multiget = CalDavUtil.parseReport('<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop><D:href>/dav/calendars/app-1/cal-1/event.ics</D:href></C:calendar-multiget>');
    expect(multiget.type).toBe('calendar-multiget');
    expect(multiget.properties).toEqual(['getetag', 'calendar-data']);
    expect(multiget.hrefs).toEqual(['/dav/calendars/app-1/cal-1/event.ics']);

    const query = CalDavUtil.parseReport('<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="20260501T000000Z" end="20260601T000000Z"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>');
    expect(query.type).toBe('calendar-query');
    expect(query.timeRange).toEqual({ start: '2026-05-01T00:00:00Z', end: '2026-06-01T00:00:00Z' });
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
    const response = await CalDavUtil.calendarObjectReport('app-1', 'cal-1', [{ href: 'missing.ics', status: 404 }], ['getetag', 'calendar-data']).text();

    expect(response).toContain('<D:href>/dav/calendars/app-1/cal-1/missing.ics</D:href>');
    expect(response).toContain('<D:status>HTTP/1.1 404 Not Found</D:status>');
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
