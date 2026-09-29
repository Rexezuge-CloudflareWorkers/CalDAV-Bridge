/**
 * Multi-Status response construction.
 *
 * The counterpart to `DavRequestParser`: this is the only place that turns
 * server state into DAV XML, so the rules that keep a response well-formed --
 * escaping, and refusing to write a client-supplied name into an element name
 * -- are enforced once, here.
 *
 * Property values are supplied as a table rather than a `switch`, so a new
 * property is a new entry rather than a new branch through a 70-line function.
 */

import { DAV_RESOURCE_MAX_BYTES } from '@caldav-bridge/shared/constants';
import type { CalendarEvent, ProviderCalendar } from '@caldav-bridge/shared/model';
import { DavPathUtil } from './DavPathUtil';
import { eventEtag } from './DavPreconditions';
import type { DavPropfindRequest } from './DavRequestParser';
import { byteLength, escapeXml, httpDate, statusText, toIcs, unique } from './DavXmlUtil';

type DavResourceKind = 'root' | 'principal' | 'calendarHome' | 'calendar' | 'object';

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
  /**
   * The event's iCalendar body, serialised at most once per response.
   *
   * `allprop` on an object asks for both `calendar-data` and `getcontentlength`,
   * and the latter needs the same bytes. Memoised here rather than recomputed
   * per property, which was two full serialisations for every object in a
   * depth-one PROPFIND.
   */
  ics?: string | undefined;
}

/** One property: what it serialises to, given the resource it is on. */
type PropertyResolver = (context: DavPropertyContext) => string | undefined;

/** Properties that live in the CalDAV namespace rather than DAV. */
const CALDAV_PROPERTIES: ReadonlySet<string> = new Set([
  'calendar-data',
  'calendar-description',
  'calendar-home-set',
  'calendar-timezone',
  'max-resource-size',
  'supported-calendar-component-set',
  'supported-calendar-data',
]);

/** Properties that live in the calendarserver.org namespace. */
const CALENDAR_SERVER_PROPERTIES: ReadonlySet<string> = new Set(['getctag']);

/** The `getlastmodified` of an event, falling back to the response time. */
function getlastmodified({ event }: DavPropertyContext): string | undefined {
  if (!event) return undefined;
  return `<D:getlastmodified>${escapeXml(httpDate(event.updated || event.created || event.start.dateTime || event.start.date))}</D:getlastmodified>`;
}

/** The `displayname` of a principal, which is the application it is bound to. */
function principalDisplayName({ applicationId }: DavPropertyContext): string {
  return `<D:displayname>${escapeXml(applicationId)}</D:displayname>`;
}

/** The iCalendar body, memoised so `getcontentlength` and this share one serialisation. */
function calendarData(context: DavPropertyContext): string | undefined {
  if (!context.event) return undefined;
  context.ics ??= toIcs(context.event);
  return `<C:calendar-data>${escapeXml(context.ics)}</C:calendar-data>`;
}

/**
 * Every property this server can answer, by name.
 *
 * A property absent from this table is reported in the response's `404` propstat,
 * which is the correct answer for one this server does not implement -- the
 * alternative, silently omitting it, leaves the client unable to tell the
 * difference between "not supported" and "forgotten".
 */
const PROPERTIES: Readonly<Record<string, PropertyResolver>> = {
  displayname: (context) => {
    const { calendar, event, objectHref } = context;
    if (event) return `<D:displayname>${escapeXml(event.summary || objectHref || event.uid)}</D:displayname>`;
    if (calendar) return `<D:displayname>${escapeXml(calendar.name)}</D:displayname>`;
    return undefined;
  },
  'current-user-principal': ({ applicationId }) =>
    `<D:current-user-principal><D:href>${escapeXml(DavPathUtil.principalHref(applicationId))}</D:href></D:current-user-principal>`,
  'principal-URL': ({ applicationId }) =>
    `<D:principal-URL><D:href>${escapeXml(DavPathUtil.principalHref(applicationId))}</D:href></D:principal-URL>`,
  'calendar-home-set': ({ applicationId }) =>
    `<C:calendar-home-set><D:href>${escapeXml(DavPathUtil.calendarHomeHref(applicationId))}</D:href></C:calendar-home-set>`,
  owner: ({ applicationId }) => `<D:owner><D:href>${escapeXml(DavPathUtil.principalHref(applicationId))}</D:href></D:owner>`,
  'calendar-description': ({ calendar }) =>
    calendar?.description
      ? `<C:calendar-description>${escapeXml(calendar.description)}</C:calendar-description>`
      : '<C:calendar-description/>',
  'supported-calendar-component-set': () =>
    '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>',
  'supported-calendar-data': () =>
    '<C:supported-calendar-data><C:calendar-data content-type="text/calendar" version="2.0"/></C:supported-calendar-data>',
  'max-resource-size': () => `<C:max-resource-size>${DAV_RESOURCE_MAX_BYTES}</C:max-resource-size>`,
  getctag: ({ collectionTag }) => (collectionTag ? `<CS:getctag>${escapeXml(collectionTag)}</CS:getctag>` : undefined),
  'sync-token': ({ syncToken }) => (syncToken ? `<D:sync-token>${escapeXml(syncToken)}</D:sync-token>` : undefined),
  'current-user-privilege-set': ({ calendar }) => privileges(calendar?.readOnly === true),
  'supported-report-set': () => SUPPORTED_REPORTS,
  getetag: ({ event }) => (event ? `<D:getetag>${escapeXml(eventEtag(event))}</D:getetag>` : undefined),
  getcontenttype: ({ event }) => (event ? '<D:getcontenttype>text/calendar; charset=utf-8</D:getcontenttype>' : undefined),
  getcontentlength: (context) => {
    if (!context.event) return undefined;
    context.ics ??= toIcs(context.event);
    return `<D:getcontentlength>${byteLength(context.ics)}</D:getcontentlength>`;
  },
  getlastmodified,
  'calendar-data': calendarData,
};

const SUPPORTED_REPORTS =
  '<D:supported-report-set><D:supported-report><D:report><C:calendar-query/></D:report></D:supported-report>' +
  '<D:supported-report><D:report><C:calendar-multiget/></D:report></D:supported-report>' +
  '<D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report></D:supported-report-set>';

function privileges(readOnly: boolean): string {
  const writePrivileges = readOnly
    ? ''
    : '<D:privilege><D:write/></D:privilege><D:privilege><D:write-content/></D:privilege><D:privilege><D:write-properties/></D:privilege><D:privilege><D:bind/></D:privilege><D:privilege><D:unbind/></D:privilege>';
  return `<D:current-user-privilege-set><D:privilege><D:read/></D:privilege>${writePrivileges}</D:current-user-privilege-set>`;
}

/** `resourcetype` is the one property whose value depends only on the resource kind. */
const RESOURCE_TYPES: Readonly<Record<DavResourceKind, string>> = {
  root: '<D:resourcetype><D:collection/></D:resourcetype>',
  principal: '<D:resourcetype><D:collection/><D:principal/></D:resourcetype>',
  calendarHome: '<D:resourcetype><D:collection/></D:resourcetype>',
  calendar: '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>',
  object: '<D:resourcetype/>',
};

/** `displayname` for the resources whose name does not come from a provider. */
const FIXED_DISPLAY_NAMES: Readonly<Record<'root' | 'calendarHome', string>> = {
  root: '<D:displayname>CalDAV Bridge</D:displayname>',
  calendarHome: '<D:displayname>Calendars</D:displayname>',
};

/** What `allprop` returns for each resource kind. */
const DEFAULT_PROPERTIES: Readonly<Record<DavResourceKind, string[]>> = {
  root: ['resourcetype', 'displayname', 'current-user-principal', 'principal-URL'],
  principal: ['resourcetype', 'displayname', 'current-user-principal', 'principal-URL', 'calendar-home-set'],
  calendarHome: ['resourcetype', 'displayname', 'owner', 'current-user-principal'],
  calendar: [
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
  ],
  // `calendar-data` belongs in `allprop` for an object: RFC 4791 §5.2.4
  // recommends it, and clients that populate from `allprop` would otherwise
  // receive metadata with no event body and show an empty entry.
  object: ['resourcetype', 'getetag', 'getcontenttype', 'getcontentlength', 'getlastmodified', 'calendar-data'],
};

class DavResponseBuilder {
  public static allowHeader(): string {
    return 'OPTIONS, PROPFIND, REPORT, GET, HEAD, PUT, DELETE';
  }

  public static xmlResponse(body: string, status = 207, headers: HeadersInit = {}): Response {
    const responseHeaders = new Headers(headers);
    responseHeaders.set('Content-Type', 'application/xml; charset=utf-8');
    responseHeaders.set('DAV', '1, 3, calendar-access');
    return new Response(body, { status, headers: responseHeaders });
  }

  public static textCalendarResponse(body: string, etag?: string, status = 200): Response {
    const headers: HeadersInit = { 'Content-Type': 'text/calendar; charset=utf-8' };
    if (etag) headers.ETag = etag;
    return new Response(body, { status, headers });
  }

  public static headCalendarResponse(event: CalendarEvent): Response {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Length': byteLength(toIcs(event)).toString(),
        ETag: eventEtag(event),
      },
    });
  }

  public static options(): Response {
    return new Response(null, {
      status: 204,
      headers: { Allow: DavResponseBuilder.allowHeader(), DAV: '1, 3, calendar-access', 'MS-Author-Via': 'DAV' },
    });
  }

  public static davError(status: number, message: string, responseHeaders: HeadersInit = {}): Response {
    const headers = new Headers(responseHeaders);
    if (status === 401) headers.set('WWW-Authenticate', 'Basic realm="CalDAV Bridge", charset="UTF-8"');
    if (status === 405) headers.set('Allow', DavResponseBuilder.allowHeader());
    return DavResponseBuilder.xmlResponse(
      `<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><D:responsedescription>${escapeXml(message)}</D:responsedescription></D:error>`,
      status,
      headers,
    );
  }

  /** The `403` a `sync-collection` earns with a token this collection did not issue. */
  public static invalidSyncToken(): Response {
    return DavResponseBuilder.xmlResponse(
      '<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>',
      403,
    );
  }

  /** The `403` a `calendar-query` earns with a filter this server cannot evaluate. */
  public static invalidFilter(reason: string): Response {
    // `valid-filter` is a precondition in the CalDAV namespace, not DAV.
    const body = `<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><C:valid-filter/><D:responsedescription>${escapeXml(reason)}</D:responsedescription></D:error>`;
    return DavResponseBuilder.xmlResponse(body, 403);
  }

  public static notFound(path: string): Response {
    return DavResponseBuilder.xmlResponse(
      `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${escapeXml(path)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response></D:multistatus>`,
      404,
    );
  }

  public static propfindRoot(applicationId: string, request: DavPropfindRequest): Response {
    return DavResponseBuilder.multistatus([DavResponseBuilder.resourceResponse('/dav/', request, 'root', { applicationId })]);
  }

  public static propfindPrincipal(applicationId: string, request: DavPropfindRequest): Response {
    return DavResponseBuilder.multistatus([
      DavResponseBuilder.resourceResponse(DavPathUtil.principalHref(applicationId), request, 'principal', { applicationId }),
    ]);
  }

  public static propfindCalendarHome(
    applicationId: string,
    calendars: ProviderCalendar[],
    request: DavPropfindRequest,
    depth: number,
  ): Response {
    const responses = [
      DavResponseBuilder.resourceResponse(DavPathUtil.calendarHomeHref(applicationId), request, 'calendarHome', { applicationId }),
    ];
    if (depth > 0) {
      responses.push(
        ...calendars.map((calendar) =>
          DavResponseBuilder.resourceResponse(DavPathUtil.calendarHref(applicationId, calendar.id), request, 'calendar', {
            applicationId,
            calendar,
            calendarId: calendar.id,
          }),
        ),
      );
    }
    return DavResponseBuilder.multistatus(responses);
  }

  public static propfindCalendar(
    applicationId: string,
    calendar: ProviderCalendar,
    request: DavPropfindRequest,
    depth: number,
    objects: DavCalendarObjectResult[] = [],
    syncToken?: string | undefined,
  ): Response {
    const responses = [
      DavResponseBuilder.resourceResponse(DavPathUtil.calendarHref(applicationId, calendar.id), request, 'calendar', {
        applicationId,
        calendar,
        calendarId: calendar.id,
        collectionTag: DavResponseBuilder.collectionTag(applicationId, calendar, objects),
        syncToken,
      }),
    ];
    if (depth > 0) {
      responses.push(
        ...objects
          .filter((object): object is DavCalendarObjectResult & { event: CalendarEvent } => Boolean(object.event))
          .map((object) =>
            DavResponseBuilder.resourceResponse(DavPathUtil.objectHref(applicationId, calendar.id, object.href), request, 'object', {
              applicationId,
              calendarId: calendar.id,
              event: object.event,
              objectHref: object.href,
            }),
          ),
      );
    }
    return DavResponseBuilder.multistatus(responses);
  }

  public static propfindObject(
    applicationId: string,
    calendarId: string,
    objectHref: string,
    event: CalendarEvent,
    request: DavPropfindRequest,
  ): Response {
    return DavResponseBuilder.multistatus([
      DavResponseBuilder.resourceResponse(DavPathUtil.objectHref(applicationId, calendarId, objectHref), request, 'object', {
        applicationId,
        calendarId,
        event,
        objectHref,
      }),
    ]);
  }

  public static calendarObjectReport(
    applicationId: string,
    calendarId: string,
    results: DavCalendarObjectResult[],
    properties: string[],
  ): Response {
    return DavResponseBuilder.multistatus(DavResponseBuilder.objectResponses(applicationId, calendarId, results, properties));
  }

  public static syncCollectionReport(
    applicationId: string,
    calendarId: string,
    results: DavCalendarObjectResult[],
    properties: string[],
    syncToken: string,
  ): Response {
    return DavResponseBuilder.multistatus(DavResponseBuilder.objectResponses(applicationId, calendarId, results, properties), syncToken);
  }

  private static objectResponses(
    applicationId: string,
    calendarId: string,
    results: DavCalendarObjectResult[],
    properties: string[],
  ): string[] {
    const request = DavResponseBuilder.reportPropRequest(properties);
    return results.map((result) => {
      const href = DavPathUtil.objectHref(applicationId, calendarId, result.href);
      if (!result.event) return DavResponseBuilder.statusResponse(href, result.status || 404);
      return DavResponseBuilder.resourceResponse(href, request, 'object', {
        applicationId,
        calendarId,
        event: result.event,
        objectHref: result.href,
      });
    });
  }

  /**
   * A change token for a collection's current contents.
   *
   * Derived from the highest sync version the collection has issued, which
   * changes exactly when its contents change. The previous form concatenated a
   * tag for every live object *and* every retained tombstone, so the value grew
   * without bound and was re-serialised into every depth-one PROPFIND. Clients
   * only compare the tag for equality, so a bounded value is equivalent.
   */
  private static collectionTag(applicationId: string, calendar: ProviderCalendar, objects: DavCalendarObjectResult[]): string {
    const calendarTag = calendar.etag || calendar.name;
    const highestVersion = objects.reduce((highest, object) => Math.max(highest, object.syncVersion || 0), 0);
    return `${applicationId}:${calendar.id}:${calendarTag}:${highestVersion}`;
  }

  private static multistatus(responses: string[], syncToken?: string | undefined): Response {
    const token = syncToken ? `<D:sync-token>${escapeXml(syncToken)}</D:sync-token>` : '';
    return DavResponseBuilder.xmlResponse(
      `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">${responses.join('')}${token}</D:multistatus>`,
    );
  }

  private static resourceResponse(
    href: string,
    request: DavPropfindRequest,
    resource: DavResourceKind,
    context: DavPropertyContext,
  ): string {
    const ok: string[] = [];
    const missing: string[] = [];
    for (const property of DavResponseBuilder.requestedProperties(request, resource)) {
      const value =
        request.mode === 'propname'
          ? DavResponseBuilder.emptyProperty(property)
          : DavResponseBuilder.propertyValue(property, resource, context);
      if (value) ok.push(value);
      else missing.push(DavResponseBuilder.emptyProperty(property));
    }
    return `<D:response><D:href>${escapeXml(href)}</D:href>${DavResponseBuilder.propstat(ok, 200)}${DavResponseBuilder.propstat(missing, 404)}</D:response>`;
  }

  private static propertyValue(property: string, resource: DavResourceKind, context: DavPropertyContext): string | undefined {
    if (property === 'resourcetype') return RESOURCE_TYPES[resource];
    if (property === 'displayname' && !context.event && !context.calendar) {
      if (resource === 'principal') return principalDisplayName(context);
      if (resource === 'root' || resource === 'calendarHome') return FIXED_DISPLAY_NAMES[resource];
    }
    return PROPERTIES[property]?.(context);
  }

  private static statusResponse(href: string, status: number): string {
    return `<D:response><D:href>${escapeXml(href)}</D:href><D:status>HTTP/1.1 ${status} ${statusText(status)}</D:status></D:response>`;
  }

  private static propstat(properties: string[], status: number): string {
    if (!properties.length) return '';
    return `<D:propstat><D:prop>${properties.join('')}</D:prop><D:status>HTTP/1.1 ${status} ${statusText(status)}</D:status></D:propstat>`;
  }

  private static requestedProperties(request: DavPropfindRequest, resource: DavResourceKind): string[] {
    if (request.mode === 'prop') return unique(request.properties);
    return DEFAULT_PROPERTIES[resource];
  }

  private static reportPropRequest(properties: string[]): DavPropfindRequest {
    return { mode: 'prop', properties: properties.length ? unique(properties) : ['getetag', 'calendar-data'] };
  }

  /**
   * An empty element for a property this server did not answer.
   *
   * The name came from the client, so it is only emitted if
   * `DavXmlScanner` read it as a well-formed XML name. Escaping cannot help
   * here: this is an element *name*, and a name containing `&` or `<` would
   * produce markup a strict client parser rejects, taking the entire
   * Multi-Status document with it.
   */
  private static emptyProperty(property: string): string {
    return `<${DavResponseBuilder.propertyTag(property)}/>`;
  }

  private static propertyTag(property: string): string {
    if (CALDAV_PROPERTIES.has(property)) return `C:${property}`;
    if (CALENDAR_SERVER_PROPERTIES.has(property)) return `CS:${property}`;
    return `D:${property}`;
  }
}

export { DavResponseBuilder };
export type { DavCalendarObjectResult };
