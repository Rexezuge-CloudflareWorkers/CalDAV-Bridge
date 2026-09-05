import type { CalendarEvent, ProviderCalendar } from '@caldav-bridge/shared/model';
import { ICalendarUtil } from './ICalendarUtil';

type DavResourceKind = 'root' | 'principal' | 'calendarHome' | 'calendar' | 'object' | 'unknown';
type DavPropMode = 'allprop' | 'prop' | 'propname';
type DavReportKind = 'calendar-query' | 'calendar-multiget' | 'sync-collection' | 'unknown';

interface DavPath {
  resource: DavResourceKind;
  applicationId?: string | undefined;
  calendarId?: string | undefined;
  objectHref?: string | undefined;
}

interface DavPropfindRequest {
  mode: DavPropMode;
  properties: string[];
}

interface DavReportRequest {
  type: DavReportKind;
  properties: string[];
  hrefs: string[];
  syncToken?: string | undefined;
  timeRange?: DavTimeRange | undefined;
}

interface DavTimeRange {
  start?: string | undefined;
  end?: string | undefined;
}

interface DavCalendarObjectResult {
  href: string;
  event?: CalendarEvent | undefined;
  status?: number | undefined;
  syncVersion?: number | undefined;
}

interface DavPropertyContext {
  applicationId: string;
  calendar?: ProviderCalendar | undefined;
  calendarId?: string | undefined;
  collectionTag?: string | undefined;
  syncToken?: string | undefined;
  event?: CalendarEvent | undefined;
  objectHref?: string | undefined;
}

class CalDavUtil {
  private static readonly calDavProperties = new Set([
    'calendar-data',
    'calendar-description',
    'calendar-home-set',
    'calendar-timezone',
    'max-resource-size',
    'supported-calendar-component-set',
    'supported-calendar-data',
  ]);

  private static readonly calendarServerProperties = new Set(['getctag']);

  public static xmlResponse(body: string, status = 207, headers: HeadersInit = {}): Response {
    const responseHeaders = new Headers(headers);
    responseHeaders.set('Content-Type', 'application/xml; charset=utf-8');
    responseHeaders.set('DAV', '1, 3, calendar-access');
    return new Response(body, {
      status,
      headers: responseHeaders,
    });
  }

  public static textCalendarResponse(body: string, etag?: string, status = 200): Response {
    const headers: HeadersInit = { 'Content-Type': 'text/calendar; charset=utf-8' };
    if (etag) headers.ETag = CalDavUtil.quoteEtag(etag);
    return new Response(body, { status, headers });
  }

  public static headCalendarResponse(event: CalendarEvent): Response {
    const body = ICalendarUtil.toICS(event);
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Length': CalDavUtil.byteLength(body).toString(),
        ETag: CalDavUtil.eventEtag(event),
      },
    });
  }

  public static options(): Response {
    return new Response(null, {
      status: 204,
      headers: {
        Allow: CalDavUtil.allowHeader(),
        DAV: '1, 3, calendar-access',
        'MS-Author-Via': 'DAV',
      },
    });
  }

  public static davError(status: number, message: string, responseHeaders: HeadersInit = {}): Response {
    const headers = new Headers(responseHeaders);
    if (status === 401) headers.set('WWW-Authenticate', 'Basic realm="CalDAV Bridge", charset="UTF-8"');
    if (status === 405) headers.set('Allow', CalDavUtil.allowHeader());
    return CalDavUtil.xmlResponse(
      `<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><D:responsedescription>${CalDavUtil.escape(message)}</D:responsedescription></D:error>`,
      status,
      headers,
    );
  }

  public static propfindRoot(applicationId: string, request: DavPropfindRequest): Response {
    return CalDavUtil.multistatus([CalDavUtil.resourceResponse('/dav/', request, 'root', { applicationId })]);
  }

  public static propfindPrincipal(applicationId: string, request: DavPropfindRequest): Response {
    return CalDavUtil.multistatus([CalDavUtil.resourceResponse(CalDavUtil.principalHref(applicationId), request, 'principal', { applicationId })]);
  }

  public static propfindCalendarHome(applicationId: string, calendars: ProviderCalendar[], request: DavPropfindRequest, depth: number): Response {
    const responses = [CalDavUtil.resourceResponse(CalDavUtil.calendarHomeHref(applicationId), request, 'calendarHome', { applicationId })];
    if (depth > 0) {
      responses.push(
        ...calendars.map((calendar) => CalDavUtil.resourceResponse(CalDavUtil.calendarHref(applicationId, calendar.id), request, 'calendar', { applicationId, calendar, calendarId: calendar.id })),
      );
    }
    return CalDavUtil.multistatus(responses);
  }

  public static propfindCalendar(applicationId: string, calendar: ProviderCalendar, request: DavPropfindRequest, depth: number, objects: DavCalendarObjectResult[] = [], syncToken?: string | undefined): Response {
    const responses = [
      CalDavUtil.resourceResponse(CalDavUtil.calendarHref(applicationId, calendar.id), request, 'calendar', {
        applicationId,
        calendar,
        calendarId: calendar.id,
        collectionTag: CalDavUtil.collectionTag(applicationId, calendar, objects),
        syncToken,
      }),
    ];
    if (depth > 0) {
      responses.push(
        ...objects
          .filter((object): object is DavCalendarObjectResult & { event: CalendarEvent } => Boolean(object.event))
          .map((object) =>
            CalDavUtil.resourceResponse(CalDavUtil.objectHref(applicationId, calendar.id, object.href), request, 'object', {
              applicationId,
              calendarId: calendar.id,
              event: object.event,
              objectHref: object.href,
            }),
          ),
      );
    }
    return CalDavUtil.multistatus(responses);
  }

  public static propfindObject(applicationId: string, calendarId: string, objectHref: string, event: CalendarEvent, request: DavPropfindRequest): Response {
    return CalDavUtil.multistatus([CalDavUtil.resourceResponse(CalDavUtil.objectHref(applicationId, calendarId, objectHref), request, 'object', { applicationId, calendarId, event, objectHref })]);
  }

  public static calendarObjectReport(applicationId: string, calendarId: string, results: DavCalendarObjectResult[], properties: string[]): Response {
    const request = CalDavUtil.reportPropRequest(properties);
    return CalDavUtil.multistatus(
      results.map((result) => {
        const href = CalDavUtil.objectHref(applicationId, calendarId, result.href);
        if (!result.event) return CalDavUtil.statusResponse(href, result.status || 404);
        return CalDavUtil.resourceResponse(href, request, 'object', { applicationId, calendarId, event: result.event, objectHref: result.href });
      }),
    );
  }

  public static syncCollectionReport(applicationId: string, calendarId: string, results: DavCalendarObjectResult[], properties: string[], syncToken: string): Response {
    const request = CalDavUtil.reportPropRequest(properties);
    return CalDavUtil.multistatus(
      results.map((result) => {
        const href = CalDavUtil.objectHref(applicationId, calendarId, result.href);
        if (!result.event) return CalDavUtil.statusResponse(href, result.status || 404);
        return CalDavUtil.resourceResponse(href, request, 'object', { applicationId, calendarId, event: result.event, objectHref: result.href });
      }),
      syncToken,
    );
  }

  public static notFound(path: string): Response {
    return CalDavUtil.xmlResponse(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${CalDavUtil.escape(path)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response></D:multistatus>`, 404);
  }

  public static parsePath(pathname: string): DavPath {
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'dav') return { resource: 'unknown' };
    if (parts.length === 1) return { resource: 'root' };
    if (parts[1] === 'principals' && parts[2] && parts.length <= 3) return { resource: 'principal', applicationId: parts[2] };
    if (parts[1] !== 'calendars' || !parts[2]) return { resource: 'unknown' };
    if (!parts[3]) return { resource: 'calendarHome', applicationId: parts[2] };
    if (!parts[4]) return { resource: 'calendar', applicationId: parts[2], calendarId: parts[3] };
    return { resource: 'object', applicationId: parts[2], calendarId: parts[3], objectHref: parts.slice(4).join('/') };
  }

  public static parseDepth(value: string | null): number {
    if (value === '1') return 1;
    return 0;
  }

  public static parsePropfind(body: string): DavPropfindRequest {
    if (!body.trim() || /<(?:[\w.-]+:)?allprop\b/i.test(body)) return { mode: 'allprop', properties: [] };
    if (/<(?:[\w.-]+:)?propname\b/i.test(body)) return { mode: 'propname', properties: [] };
    return { mode: 'prop', properties: CalDavUtil.extractPropNames(body) };
  }

  public static parseReport(body: string): DavReportRequest {
    const rootName = CalDavUtil.firstElementName(body);
    const type = rootName === 'calendar-query' || rootName === 'calendar-multiget' || rootName === 'sync-collection' ? rootName : 'unknown';
    return {
      type,
      properties: CalDavUtil.extractPropNames(body),
      hrefs: CalDavUtil.extractHrefs(body),
      syncToken: CalDavUtil.extractElementText(body, 'sync-token'),
      timeRange: CalDavUtil.extractTimeRange(body),
    };
  }

  public static syncToken(applicationId: string, calendarId: string, syncVersion: number): string {
    return `caldav-bridge:${encodeURIComponent(applicationId)}:${encodeURIComponent(calendarId)}:${Math.max(0, Math.trunc(syncVersion))}`;
  }

  public static syncVersionFromToken(syncToken?: string | undefined): number {
    if (!syncToken) return 0;
    const version = Number(syncToken.split(':').pop());
    return Number.isFinite(version) && version > 0 ? Math.trunc(version) : 0;
  }

  public static objectHrefFromDavHref(href: string, applicationId: string, calendarId: string): string | undefined {
    let pathname = href;
    try {
      pathname = new URL(href, 'https://caldav-bridge.invalid').pathname;
    } catch {
      pathname = href;
    }
    const path = CalDavUtil.parsePath(pathname);
    if (path.resource === 'object' && path.applicationId === applicationId && path.calendarId === calendarId) return path.objectHref;
    if (!href.startsWith('/')) return decodeURIComponent(href);
    return undefined;
  }

  public static providerEventIdFromObjectHref(objectHref: string): string {
    return decodeURIComponent(objectHref.replace(/\.ics$/i, ''));
  }

  public static calendarHref(applicationId: string, calendarId: string): string {
    return `${CalDavUtil.calendarHomeHref(applicationId)}${encodeURIComponent(calendarId)}/`;
  }

  public static objectHref(applicationId: string, calendarId: string, objectHref: string): string {
    return `${CalDavUtil.calendarHref(applicationId, calendarId)}${encodeURIComponent(objectHref)}`;
  }

  public static eventEtag(event: CalendarEvent): string {
    return CalDavUtil.quoteEtag(event.etag || event.updated || event.uid);
  }

  public static quoteEtag(value: string): string {
    const trimmed = value.trim();
    if (/^(?:W\/)?".*"$/.test(trimmed)) return trimmed;
    return `"${trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  public static etagMatches(condition: string | null, currentEtag?: string | undefined): boolean {
    if (!condition) return true;
    if (condition.trim() === '*') return Boolean(currentEtag);
    if (!currentEtag) return false;
    const normalizedCurrent = CalDavUtil.normalizeEtag(currentEtag);
    return condition.split(',').some((item) => CalDavUtil.normalizeEtag(item) === normalizedCurrent);
  }

  public static allowHeader(): string {
    return 'OPTIONS, PROPFIND, REPORT, GET, HEAD, PUT, DELETE';
  }

  private static multistatus(responses: string[], syncToken?: string | undefined): Response {
    const token = syncToken ? `<D:sync-token>${CalDavUtil.escape(syncToken)}</D:sync-token>` : '';
    return CalDavUtil.xmlResponse(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">${responses.join('')}${token}</D:multistatus>`);
  }

  private static resourceResponse(href: string, request: DavPropfindRequest, resource: DavResourceKind, context: DavPropertyContext): string {
    const properties = CalDavUtil.requestedProperties(request, resource);
    const okProperties: string[] = [];
    const missingProperties: string[] = [];

    for (const property of properties) {
      const value = request.mode === 'propname' ? CalDavUtil.emptyProperty(property) : CalDavUtil.propertyValue(property, resource, context);
      if (value) okProperties.push(value);
      else missingProperties.push(CalDavUtil.emptyProperty(property));
    }

    return `<D:response><D:href>${CalDavUtil.escape(href)}</D:href>${CalDavUtil.propstat(okProperties, 200)}${CalDavUtil.propstat(missingProperties, 404)}</D:response>`;
  }

  private static statusResponse(href: string, status: number): string {
    return `<D:response><D:href>${CalDavUtil.escape(href)}</D:href><D:status>HTTP/1.1 ${status} ${CalDavUtil.statusText(status)}</D:status></D:response>`;
  }

  private static propstat(properties: string[], status: number): string {
    if (!properties.length) return '';
    return `<D:propstat><D:prop>${properties.join('')}</D:prop><D:status>HTTP/1.1 ${status} ${CalDavUtil.statusText(status)}</D:status></D:propstat>`;
  }

  private static requestedProperties(request: DavPropfindRequest, resource: DavResourceKind): string[] {
    if (request.mode === 'prop') return CalDavUtil.unique(request.properties);
    return CalDavUtil.defaultProperties(resource);
  }

  private static defaultProperties(resource: DavResourceKind): string[] {
    if (resource === 'root') return ['resourcetype', 'displayname', 'current-user-principal', 'principal-URL'];
    if (resource === 'principal') return ['resourcetype', 'displayname', 'current-user-principal', 'principal-URL', 'calendar-home-set'];
    if (resource === 'calendarHome') return ['resourcetype', 'displayname', 'owner', 'current-user-principal'];
    if (resource === 'calendar') {
      return [
        'resourcetype',
        'displayname',
        'owner',
        'calendar-description',
        'supported-calendar-component-set',
        'supported-calendar-data',
        'max-resource-size',
        'getctag',
        'sync-token',
        'current-user-privilege-set',
        'supported-report-set',
      ];
    }
    if (resource === 'object') return ['resourcetype', 'getetag', 'getcontenttype', 'getcontentlength', 'getlastmodified'];
    return [];
  }

  private static reportPropRequest(properties: string[]): DavPropfindRequest {
    return { mode: 'prop', properties: properties.length ? CalDavUtil.unique(properties) : ['getetag', 'calendar-data'] };
  }

  private static propertyValue(property: string, resource: DavResourceKind, context: DavPropertyContext): string | undefined {
    const applicationId = context.applicationId;
    const principalHref = CalDavUtil.principalHref(applicationId);
    const homeHref = CalDavUtil.calendarHomeHref(applicationId);
    const event = context.event;
    const calendar = context.calendar;

    switch (property) {
      case 'resourcetype':
        if (resource === 'root' || resource === 'calendarHome') return '<D:resourcetype><D:collection/></D:resourcetype>';
        if (resource === 'principal') return '<D:resourcetype><D:collection/><D:principal/></D:resourcetype>';
        if (resource === 'calendar') return '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>';
        if (resource === 'object') return '<D:resourcetype/>';
        return undefined;
      case 'displayname':
        if (resource === 'root') return '<D:displayname>CalDAV Bridge</D:displayname>';
        if (resource === 'principal') return `<D:displayname>${CalDavUtil.escape(applicationId)}</D:displayname>`;
        if (resource === 'calendarHome') return '<D:displayname>Calendars</D:displayname>';
        if (resource === 'calendar' && calendar) return `<D:displayname>${CalDavUtil.escape(calendar.name)}</D:displayname>`;
        if (resource === 'object' && event) return `<D:displayname>${CalDavUtil.escape(event.summary || context.objectHref || event.uid)}</D:displayname>`;
        return undefined;
      case 'current-user-principal':
        return `<D:current-user-principal><D:href>${CalDavUtil.escape(principalHref)}</D:href></D:current-user-principal>`;
      case 'principal-URL':
        return `<D:principal-URL><D:href>${CalDavUtil.escape(principalHref)}</D:href></D:principal-URL>`;
      case 'calendar-home-set':
        return `<C:calendar-home-set><D:href>${CalDavUtil.escape(homeHref)}</D:href></C:calendar-home-set>`;
      case 'owner':
        return `<D:owner><D:href>${CalDavUtil.escape(principalHref)}</D:href></D:owner>`;
      case 'calendar-description':
        return calendar?.description ? `<C:calendar-description>${CalDavUtil.escape(calendar.description)}</C:calendar-description>` : '<C:calendar-description/>';
      case 'supported-calendar-component-set':
        return '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>';
      case 'supported-calendar-data':
        return '<C:supported-calendar-data><C:calendar-data content-type="text/calendar" version="2.0"/></C:supported-calendar-data>';
      case 'max-resource-size':
        return '<C:max-resource-size>10485760</C:max-resource-size>';
      case 'getctag':
        return context.collectionTag ? `<CS:getctag>${CalDavUtil.escape(context.collectionTag)}</CS:getctag>` : undefined;
      case 'sync-token':
        return context.syncToken ? `<D:sync-token>${CalDavUtil.escape(context.syncToken)}</D:sync-token>` : undefined;
      case 'current-user-privilege-set':
        return CalDavUtil.privileges(calendar?.readOnly === true);
      case 'supported-report-set':
        if (resource !== 'calendar') return '<D:supported-report-set/>';
        return '<D:supported-report-set><D:supported-report><D:report><C:calendar-query/></D:report></D:supported-report><D:supported-report><D:report><C:calendar-multiget/></D:report></D:supported-report><D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report></D:supported-report-set>';
      case 'getetag':
        return event ? `<D:getetag>${CalDavUtil.escape(CalDavUtil.eventEtag(event))}</D:getetag>` : undefined;
      case 'getcontenttype':
        return event ? '<D:getcontenttype>text/calendar; charset=utf-8</D:getcontenttype>' : undefined;
      case 'getcontentlength':
        return event ? `<D:getcontentlength>${CalDavUtil.byteLength(ICalendarUtil.toICS(event))}</D:getcontentlength>` : undefined;
      case 'getlastmodified':
        return event ? `<D:getlastmodified>${CalDavUtil.escape(CalDavUtil.httpDate(event.updated || event.created || event.start.dateTime || event.start.date))}</D:getlastmodified>` : undefined;
      case 'calendar-data':
        return event ? `<C:calendar-data>${CalDavUtil.escape(ICalendarUtil.toICS(event))}</C:calendar-data>` : undefined;
      default:
        return undefined;
    }
  }

  private static privileges(readOnly: boolean): string {
    const writePrivileges = readOnly
      ? ''
      : '<D:privilege><D:write/></D:privilege><D:privilege><D:write-content/></D:privilege><D:privilege><D:write-properties/></D:privilege><D:privilege><D:bind/></D:privilege><D:privilege><D:unbind/></D:privilege>';
    return `<D:current-user-privilege-set><D:privilege><D:read/></D:privilege>${writePrivileges}</D:current-user-privilege-set>`;
  }

  private static collectionTag(applicationId: string, calendar: ProviderCalendar, objects: DavCalendarObjectResult[]): string {
    const calendarTag = calendar.etag || calendar.name;
    const objectTags = objects
      .map((object) => {
        const version = object.syncVersion ? `:${object.syncVersion}` : '';
        return object.event
          ? `${object.href}:${object.event.etag || object.event.updated || object.event.uid}${version}`
          : `${object.href}:deleted:${object.status || 404}${version}`;
      })
      .sort()
      .join('|');
    return `${applicationId}:${calendar.id}:${objectTags ? `${calendarTag}:${objectTags}` : calendarTag}`;
  }

  private static emptyProperty(property: string): string {
    return `<${CalDavUtil.propertyTag(property)}/>`;
  }

  private static propertyTag(property: string): string {
    if (CalDavUtil.calDavProperties.has(property)) return `C:${property}`;
    if (CalDavUtil.calendarServerProperties.has(property)) return `CS:${property}`;
    return `D:${property}`;
  }

  private static principalHref(applicationId: string): string {
    return `/dav/principals/${encodeURIComponent(applicationId)}/`;
  }

  private static calendarHomeHref(applicationId: string): string {
    return `/dav/calendars/${encodeURIComponent(applicationId)}/`;
  }

  private static firstElementName(xml: string): string {
    const match = /<(?!\?|!|\/)(?:[\w.-]+:)?([\w.-]+)\b/i.exec(xml);
    return match?.[1] || '';
  }

  private static extractPropNames(xml: string): string[] {
    const match = /<(?:[\w.-]+:)?prop\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?prop>/i.exec(xml);
    if (!match) return [];
    return CalDavUtil.unique(CalDavUtil.directChildElementNames(match[1] || ''));
  }

  private static directChildElementNames(xml: string): string[] {
    const names: string[] = [];
    const tagRegex = /<\s*(\/)?\s*([^\s>/!?]+)[^>]*(\/)?\s*>/g;
    let depth = 0;
    let match: RegExpExecArray | null;
    while ((match = tagRegex.exec(xml))) {
      const closing = Boolean(match[1]);
      const rawName = match[2] || '';
      const selfClosing = Boolean(match[3]) || /\/\s*>$/.test(match[0]);
      if (rawName.startsWith('?') || rawName.startsWith('!')) continue;
      if (closing) {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (depth === 0) names.push(CalDavUtil.localName(rawName));
      if (!selfClosing) depth += 1;
    }
    return names;
  }

  private static extractHrefs(xml: string): string[] {
    const hrefs: string[] = [];
    const regex = /<(?:[\w.-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?href>/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(xml))) hrefs.push(CalDavUtil.unescapeXml((match[1] || '').trim()));
    return hrefs;
  }

  private static extractElementText(xml: string, name: string): string | undefined {
    const match = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}>`, 'i').exec(xml);
    return match ? CalDavUtil.unescapeXml((match[1] || '').trim()) : undefined;
  }

  private static extractTimeRange(xml: string): DavTimeRange | undefined {
    const match = /<(?:[\w.-]+:)?time-range\b([^>]*)>/i.exec(xml);
    if (!match) return undefined;
    const start = CalDavUtil.attribute(match[1] || '', 'start');
    const end = CalDavUtil.attribute(match[1] || '', 'end');
    return { start: CalDavUtil.dateTimeFromICal(start), end: CalDavUtil.dateTimeFromICal(end) };
  }

  private static attribute(attributes: string, name: string): string | undefined {
    const match = new RegExp(`${name}=["']([^"']+)["']`, 'i').exec(attributes);
    return match?.[1];
  }

  private static dateTimeFromICal(value?: string | undefined): string | undefined {
    if (!value) return undefined;
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value);
    if (!match) return value;
    return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  }

  private static localName(name: string): string {
    return name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
  }

  private static normalizeEtag(value: string): string {
    return CalDavUtil.quoteEtag(value.replace(/^W\//, '').trim()).replace(/^W\//, '');
  }

  private static httpDate(value?: string | undefined): string {
    const date = value ? new Date(value) : new Date();
    return Number.isNaN(date.getTime()) ? new Date().toUTCString() : date.toUTCString();
  }

  private static byteLength(value: string): number {
    return new TextEncoder().encode(value).length;
  }

  private static unique(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
  }

  private static statusText(status: number): string {
    switch (status) {
      case 200:
        return 'OK';
      case 201:
        return 'Created';
      case 204:
        return 'No Content';
      case 400:
        return 'Bad Request';
      case 401:
        return 'Unauthorized';
      case 403:
        return 'Forbidden';
      case 404:
        return 'Not Found';
      case 405:
        return 'Method Not Allowed';
      case 409:
        return 'Conflict';
      case 412:
        return 'Precondition Failed';
      case 415:
        return 'Unsupported Media Type';
      case 501:
        return 'Not Implemented';
      case 503:
        return 'Service Unavailable';
      default:
        return 'Error';
    }
  }

  private static escape(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private static unescapeXml(value: string): string {
    return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
}

export { CalDavUtil };
export type { DavCalendarObjectResult, DavPath, DavPropfindRequest, DavReportRequest, DavTimeRange };
