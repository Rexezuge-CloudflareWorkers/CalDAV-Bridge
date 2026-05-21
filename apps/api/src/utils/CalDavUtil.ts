import type { CalendarEvent, ProviderCalendar } from '@caldav-bridge/shared/model';
import { ICalendarUtil } from './ICalendarUtil';

class CalDavUtil {
  public static xmlResponse(body: string, status = 207): Response {
    return new Response(body, {
      status,
      headers: { 'Content-Type': 'application/xml; charset=utf-8', DAV: '1, 3, calendar-access' },
    });
  }

  public static options(): Response {
    return new Response(null, {
      status: 204,
      headers: {
        Allow: 'OPTIONS, PROPFIND, REPORT, GET, PUT, DELETE',
        DAV: '1, 3, calendar-access',
        'MS-Author-Via': 'DAV',
      },
    });
  }

  public static principal(baseUrl: string, applicationId: string): Response {
    return CalDavUtil.xmlResponse(`<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response><D:href>/dav/principals/${applicationId}/</D:href><D:propstat><D:prop>
    <D:displayname>${CalDavUtil.escape(applicationId)}</D:displayname>
    <C:calendar-home-set><D:href>/dav/calendars/${applicationId}/</D:href></C:calendar-home-set>
    <D:current-user-principal><D:href>/dav/principals/${applicationId}/</D:href></D:current-user-principal>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`.replace(baseUrl, ''));
  }

  public static calendarHome(applicationId: string, calendars: ProviderCalendar[]): Response {
    const responses = calendars
      .map(
        (calendar) => `<D:response><D:href>/dav/calendars/${applicationId}/${encodeURIComponent(calendar.id)}/</D:href><D:propstat><D:prop>
  <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
  <D:displayname>${CalDavUtil.escape(calendar.name)}</D:displayname>
  <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
      )
      .join('');
    return CalDavUtil.xmlResponse(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${responses}</D:multistatus>`);
  }

  public static calendarObjects(applicationId: string, calendarId: string, events: CalendarEvent[]): Response {
    const responses = events
      .map((event) => {
        const href = ICalendarUtil.eventHref(event);
        return `<D:response><D:href>/dav/calendars/${applicationId}/${encodeURIComponent(calendarId)}/${href}</D:href><D:propstat><D:prop><D:getetag>${CalDavUtil.escape(event.etag || event.updated || event.uid)}</D:getetag><C:calendar-data>${CalDavUtil.escape(ICalendarUtil.toICS(event))}</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
      })
      .join('');
    return CalDavUtil.xmlResponse(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${responses}</D:multistatus>`);
  }

  public static notFound(path: string): Response {
    return CalDavUtil.xmlResponse(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${CalDavUtil.escape(path)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response></D:multistatus>`, 404);
  }

  public static parsePath(pathname: string): { applicationId?: string; calendarId?: string; objectHref?: string } {
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'dav' || parts[1] !== 'calendars') return {};
    return { applicationId: parts[2], calendarId: parts[3], objectHref: parts[4] };
  }

  private static escape(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

export { CalDavUtil };
