import { describe, expect, it } from 'vitest';
import { CalDavUtil } from '@/utils';

describe('CalDavUtil', () => {
  it('parses DAV resource paths', () => {
    expect(CalDavUtil.parsePath('/dav/')).toEqual({ resource: 'root' });
    expect(CalDavUtil.parsePath('/dav/principals/app-1/')).toEqual({ resource: 'principal', applicationId: 'app-1' });
    expect(CalDavUtil.parsePath('/dav/calendars/app-1/')).toEqual({ resource: 'calendarHome', applicationId: 'app-1' });
    expect(CalDavUtil.parsePath('/dav/calendars/app-1/cal%40example.com/')).toEqual({ resource: 'calendar', applicationId: 'app-1', calendarId: 'cal@example.com' });
    expect(CalDavUtil.parsePath('/dav/calendars/app-1/cal%40example.com/event.ics')).toEqual({ resource: 'object', applicationId: 'app-1', calendarId: 'cal@example.com', objectHref: 'event.ics' });
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

  it('matches conditional etag headers', () => {
    expect(CalDavUtil.etagMatches('"etag-1"', 'etag-1')).toBe(true);
    expect(CalDavUtil.etagMatches('"etag-1", "etag-2"', 'etag-2')).toBe(true);
    expect(CalDavUtil.etagMatches('"etag-1"', 'etag-2')).toBe(false);
    expect(CalDavUtil.etagMatches('*', 'etag-2')).toBe(true);
    expect(CalDavUtil.etagMatches('*')).toBe(false);
  });

  it('returns a Basic challenge for DAV auth errors', () => {
    const response = CalDavUtil.davError(401, 'Valid CalDAV credentials are required.');
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="CalDAV Bridge", charset="UTF-8"');
  });
});
