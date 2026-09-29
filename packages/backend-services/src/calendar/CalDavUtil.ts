import { BadRequestError } from '@caldav-bridge/backend-errors';
import { DAV_RESOURCE_MAX_BYTES } from '@caldav-bridge/shared/constants';
import type { CalendarEvent, ProviderCalendar } from '@caldav-bridge/shared/model';
import {
  allElementTexts,
  attributeValue,
  directChildNames,
  firstElementAttributes,
  firstElementName,
  firstElementText,
  parseDavXml,
} from './DavXmlScanner';
import { ICalendarUtil } from './ICalendarUtil';

/** Percent-decoding that reports a malformed escape instead of throwing. */
function safeDecodeURIComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

type DavResourceKind = 'root' | 'principal' | 'calendarHome' | 'calendar' | 'object' | 'unknown' | 'invalid';

/** Namespace for the tokens this server issues, so a foreign one is recognisable. */
const SYNC_TOKEN_PREFIX = 'caldav-bridge:';
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
  /** Set when a `calendar-query` filter names something this server cannot evaluate. */
  unsupportedFilter?: string | undefined;
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
    const parts: string[] = [];
    for (const segment of pathname.split('/')) {
      if (!segment) continue;
      const decoded = CalDavUtil.safeDecode(segment);
      // A malformed escape is a broken request target, not an absent resource.
      // Reporting it as `unknown` would answer 404 and hide a client bug.
      if (decoded === undefined) return { resource: 'invalid' };
      parts.push(decoded);
    }
    if (parts[0] !== 'dav') return { resource: 'unknown' };
    if (parts.length === 1) return { resource: 'root' };
    if (parts[1] === 'principals' && parts[2] && parts.length <= 3) return { resource: 'principal', applicationId: parts[2] };
    if (parts[1] !== 'calendars' || !parts[2]) return { resource: 'unknown' };
    if (!parts[3]) return { resource: 'calendarHome', applicationId: parts[2] };
    if (!parts[4]) return { resource: 'calendar', applicationId: parts[2], calendarId: parts[3] };
    const objectHref = parts.slice(4).join('/');
    // `URL` normalises a literal `..` but not `%2e%2e`, so a traversal that
    // survives this point would be carried into the mapping lookups and, from
    // there, into anything that later joins an href into a path or a log line.
    if (!CalDavUtil.isContainedObjectHref(objectHref)) return { resource: 'invalid' };
    return { resource: 'object', applicationId: parts[2], calendarId: parts[3], objectHref };
  }

  /**
   * The `Depth` header as a level.
   *
   * RFC 4918 §9.1 lets a server refuse `infinity`, but it must then answer as
   * `1` rather than `0`. Returning `0` silently under-reports: a client that
   * asks for the members of a calendar collection and receives only the
   * collection discovers no events at all, and shows an empty calendar with
   * nothing to indicate why.
   */
  public static parseDepth(value: string | null): number {
    const normalized = (value ?? '').trim().toLowerCase();
    if (normalized === '1' || normalized === 'infinity') return 1;
    return 0;
  }

  public static parsePropfind(body: string): DavPropfindRequest {
    if (!body.trim() || /<(?:[\w.-]+:)?allprop\b/i.test(body)) return { mode: 'allprop', properties: [] };
    if (/<(?:[\w.-]+:)?propname\b/i.test(body)) return { mode: 'propname', properties: [] };
    return { mode: 'prop', properties: CalDavUtil.extractPropNames(body) };
  }

  /**
   * Parse a REPORT body.
   *
   * A `calendar-query` filter is validated here rather than being partially
   * ignored. Only `VCALENDAR/VEVENT` with an optional `time-range` is
   * evaluable; a filter on `VALARM`, a `text-match`, or a component this server
   * does not model would otherwise be dropped and the server would return events
   * that do *not* match what the client asked for, which RFC 4791 §7.8 forbids.
   * A filter that cannot be honoured is reported so the caller can answer `403`
   * with a `valid-filter` precondition.
   */
  public static parseReport(body: string): DavReportRequest {
    const rootName = CalDavUtil.firstElementName(body);
    const type = rootName === 'calendar-query' || rootName === 'calendar-multiget' || rootName === 'sync-collection' ? rootName : 'unknown';
    const filter = type === 'calendar-query' ? CalDavUtil.parseQueryFilter(body) : undefined;
    return {
      type,
      properties: CalDavUtil.extractPropNames(body),
      hrefs: CalDavUtil.extractHrefs(body),
      // Only the direct child of `<D:sync>` is a request token. Matching the
      // first `sync-token` anywhere would pick up a property of the same name
      // nested in `<D:prop>`.
      syncToken: CalDavUtil.extractSyncToken(body),
      timeRange: filter?.timeRange,
      unsupportedFilter: filter?.unsupported,
    };
  }

  /**
   * The request's sync token, from `<D:sync>` or the report root.
   *
   * Only direct children count. Taking the first `sync-token` anywhere in the
   * body -- as the previous implementation did -- would pick up a property of
   * the same name requested inside `<D:prop>`, and use it as the client's
   * position. RFC 4791 §7.2 places it under `<D:sync>`, but the report root is
   * accepted too because clients send it there and it is unambiguous there.
   */
  private static extractSyncToken(xml: string): string | undefined {
    const document = parseDavXml(xml);
    for (let index = 0; index < document.tags.length; index += 1) {
      const tag = document.tags[index];
      if (tag.closing || (tag.localName !== 'sync' && index !== 0)) continue;
      for (const child of document.tags) {
        if (child.closing || child.parent !== index || child.localName !== 'sync-token') continue;
        const text = CalDavUtil.unescapeXml(document.source.slice(child.contentStart, child.contentEnd).trim());
        if (text) return text;
      }
    }
    return undefined;
  }

  /**
   * Read a `calendar-query` filter, or record that it cannot be evaluated.
   *
   * Nesting is what the shape check is for: the filter must be exactly
   * `VCALENDAR > VEVENT`, optionally carrying a single `time-range`. Anything
   * deeper, or any other `comp-filter`, is beyond what this server models.
   */
  private static parseQueryFilter(xml: string): { timeRange?: DavTimeRange | undefined; unsupported?: string } {
    const document = parseDavXml(xml);
    const calendarFilter = document.tags.find((tag) => !tag.closing && tag.localName === 'comp-filter');
    if (!calendarFilter) return { unsupported: 'missing comp-filter' };
    const calendarIndex = document.tags.indexOf(calendarFilter);
    const children = document.tags.filter((tag) => !tag.closing && tag.parent === calendarIndex);
    if (attributeValue(calendarFilter.attributes, 'name') !== 'VCALENDAR') return { unsupported: 'unsupported calendar component' };

    for (const child of children) {
      const childIndex = document.tags.indexOf(child);
      if (child.localName !== 'comp-filter') return { unsupported: `unsupported filter element: ${child.localName}` };
      if (attributeValue(child.attributes, 'name') !== 'VEVENT') return { unsupported: 'unsupported event component' };
      const grandChildren = document.tags.filter((tag) => !tag.closing && tag.parent === childIndex);
      for (const leaf of grandChildren) {
        if (leaf.localName !== 'time-range') return { unsupported: `unsupported filter element: ${leaf.localName}` };
      }
      const timeRange = CalDavUtil.extractTimeRange(document.source.slice(child.contentStart, child.contentEnd));
      if (timeRange) return { timeRange };
    }
    return {};
  }

  public static syncToken(applicationId: string, calendarId: string, syncVersion: number): string {
    return `${SYNC_TOKEN_PREFIX}${encodeURIComponent(applicationId)}:${encodeURIComponent(calendarId)}:${Math.max(0, Math.trunc(syncVersion))}`;
  }

  /** The `403` a `sync-collection` earns with a token this collection did not issue. */
  public static invalidSyncToken(): Response {
    const headers = new Headers({ 'Content-Type': 'application/xml; charset=utf-8', DAV: '1, 3, calendar-access' });
    return new Response('<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>', { status: 403, headers });
  }

  /**
   * The `403` a `calendar-query` earns with a filter this server cannot evaluate.
   *
   * RFC 4791 §7.8 requires a `valid-filter` precondition rather than a best-effort
   * answer, because a partial answer is indistinguishable from a complete one
   * and the client cannot tell that events are missing.
   */
  public static invalidFilter(reason: string): Response {
    const headers = new Headers({ 'Content-Type': 'application/xml; charset=utf-8', DAV: '1, 3, calendar-access' });
    // `valid-filter` is a precondition in the CalDAV namespace, not DAV.
    const body = `<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><C:valid-filter/><D:responsedescription>${CalDavUtil.escape(reason)}</D:responsedescription></D:error>`;
    return new Response(body, { status: 403, headers });
  }

  /**
   * A sync token, and the version it encodes.
   *
   * The token is bound to the collection it was issued for. RFC 4791 §7.2
   * requires a token from a different collection to be refused with `403` and a
   * `<D:valid-sync-token/>` precondition, so a client that has lost its state is
   * told to re-provision rather than being handed a full collection as though
   * it had asked for a delta. An absent token is the one legitimate exception:
   * it is how a client starts a sync.
   */
  public static parseSyncToken(syncToken: string | undefined, applicationId: string, calendarId: string): { version: number } | { invalid: true } {
    if (!syncToken) return { version: 0 };
    if (!syncToken.startsWith(SYNC_TOKEN_PREFIX)) return { invalid: true };
    const parts = syncToken.slice(SYNC_TOKEN_PREFIX.length).split(':');
    if (parts.length !== 3) return { invalid: true };
    const [tokenApplicationId, tokenCalendarId, rawVersion] = parts;
    if (safeDecodeURIComponent(tokenApplicationId) !== applicationId) return { invalid: true };
    if (safeDecodeURIComponent(tokenCalendarId) !== calendarId) return { invalid: true };
    if (!/^\d+$/.test(rawVersion as string)) return { invalid: true };
    return { version: Number(rawVersion) };
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
    // A bare relative href from a client that does not spell out the full
    // collection path. It is still held to the same containment rule, otherwise
    // `../../other` would be accepted as a legitimate object name.
    if (!href.startsWith('/')) {
      const decoded = CalDavUtil.safeDecode(href);
      return decoded !== undefined && CalDavUtil.isContainedObjectHref(decoded) ? decoded : undefined;
    }
    return undefined;
  }

  public static providerEventIdFromObjectHref(objectHref: string): string {
    return CalDavUtil.safeDecode(objectHref.replace(/\.ics$/i, '')) ?? '';
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

  /**
   * Evaluate a conditional header against the current ETag.
   *
   * `If-Match` is compared with the *strong* function RFC 7232 §3.1 requires:
   * `W/"x"` does not match a resource whose ETag is `"x"`, because weak
   * comparison is only appropriate where byte-identity is not required.
   * `If-None-Match` uses the weak function, so a `W/` prefix is ignored there.
   */
  public static etagMatches(condition: string | null, currentEtag?: string | undefined, mode: 'strong' | 'weak' = 'strong'): boolean {
    if (!condition) return true;
    const trimmed = condition.trim();
    if (trimmed === '*') return Boolean(currentEtag);
    if (!currentEtag) return false;
    const normalize = mode === 'strong' ? CalDavUtil.strongEtag : CalDavUtil.weakEtag;
    return CalDavUtil.parseEtagList(trimmed).some((candidate) => normalize(candidate) === normalize(currentEtag));
  }

  /**
   * Split a comma-separated ETag list.
   *
   * `split(',')` is wrong: an entity tag may contain a comma (`W/"a,b"`), so a
   * naive split yields fragments that match nothing. Each element is a quoted
   * string or `*`, and the quote is what delimits it.
   */
  private static parseEtagList(condition: string): string[] {
    return (condition.match(/(?:W\/)?"(?:[^"\\]|\\.)*"|\*/g) ?? []).map((item) => item.trim()).filter(Boolean);
  }

  /** ETag identity for strong comparison: the `W/` prefix is significant. */
  private static strongEtag(value: string): string {
    return CalDavUtil.quoteEtag(value.trim());
  }

  /** ETag identity for weak comparison: `W/` is not significant. */
  private static weakEtag(value: string): string {
    return CalDavUtil.quoteEtag(value.replace(/^W\//, '').trim());
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
    // `calendar-data` belongs in `allprop` for an object: RFC 4791 §5.2.4
    // recommends it, and clients that populate from `allprop` would otherwise
    // receive metadata with no event body and show an empty entry.
    if (resource === 'object') return ['resourcetype', 'getetag', 'getcontenttype', 'getcontentlength', 'getlastmodified', 'calendar-data'];
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
        return `<C:max-resource-size>${DAV_RESOURCE_MAX_BYTES}</C:max-resource-size>`;
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
      case 'getcontentlength': {
        if (!event) return undefined;
        // `allprop` asks for this alongside `calendar-data`, so the body is
        // serialised once per object rather than twice.
        const ics = event ? ICalendarUtil.toICS(event) : undefined;
        context.ics ??= ics;
        return `<D:getcontentlength>${CalDavUtil.byteLength(ics as string)}</D:getcontentlength>`;
      }
      case 'getlastmodified':
        return event ? `<D:getlastmodified>${CalDavUtil.escape(CalDavUtil.httpDate(event.updated || event.created || event.start.dateTime || event.start.date))}</D:getlastmodified>` : undefined;
      case 'calendar-data': {
        if (!event) return undefined;
        context.ics ??= ICalendarUtil.toICS(event);
        return `<C:calendar-data>${CalDavUtil.escape(context.ics)}</C:calendar-data>`;
      }
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
    return firstElementName(xml);
  }

  private static extractPropNames(xml: string): string[] {
    return CalDavUtil.unique(directChildNames(xml, 'prop'));
  }

  private static extractHrefs(xml: string): string[] {
    return allElementTexts(xml, 'href', CalDavUtil.unescapeXml);
  }

  private static extractElementText(xml: string, name: string): string | undefined {
    return firstElementText(xml, name, CalDavUtil.unescapeXml);
  }

  /**
   * The `time-range` of a query, as ISO instants.
   *
   * Both bounds are validated. An unparseable value used to be passed through
   * verbatim, where `new Date('20260501')` yields an Invalid Date, the bound
   * silently became unbounded, and the query returned the whole calendar as
   * though a narrow window had been asked for. A range that is inverted is
   * rejected too, rather than quietly matching nothing.
   */
  private static extractTimeRange(xml: string): DavTimeRange | undefined {
    const attributes = firstElementAttributes(xml, 'time-range');
    if (attributes === undefined) return undefined;
    const start = CalDavUtil.dateTimeFromICal(attributeValue(attributes, 'start'));
    const end = CalDavUtil.dateTimeFromICal(attributeValue(attributes, 'end'));
    if (CalDavUtil.isUnparseableBound(start) || CalDavUtil.isUnparseableBound(end)) throw new BadRequestError('time-range bound is not a valid date or date-time.');
    if (start && end && new Date(start).getTime() > new Date(end).getTime())
      throw new BadRequestError('time-range start must not be after its end.');
    return { start, end };
  }

  /** A bound the server could not turn into a moment in time. */
  private static isUnparseableBound(value: string | undefined): boolean {
    return value !== undefined && Number.isNaN(new Date(value).getTime());
  }

  private static attribute(attributes: string, name: string): string | undefined {
    return attributeValue(attributes, name);
  }

  /**
   * Normalise an iCalendar date or date-time to an ISO instant.
   *
   * RFC 4791 requires UTC date-times, but DATE values (`20260501`) and values
   * with a trailing `Z` are both legal to receive, so each is rewritten into
   * something `Date` parses. Anything left unrecognised is returned as-is for
   * the caller to reject, rather than being coerced into a plausible instant.
   */
  private static dateTimeFromICal(value?: string | undefined): string | undefined {
    if (!value) return undefined;
    const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T00:00:00Z`;
    const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
    if (!dateTime) return value;
    return `${dateTime[1]}-${dateTime[2]}-${dateTime[3]}T${dateTime[4]}:${dateTime[5]}:${dateTime[6]}Z`;
  }

  private static localName(name: string): string {
    return name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
  }

  /** `undefined` marks a malformed percent-escape, which is a client error rather than a missing value. */
  private static safeDecode(value: string): string | undefined {
    return safeDecodeURIComponent(value);
  }

  /**
   * Reject any href that could name something outside its own collection.
   *
   * Nesting is allowed because clients legitimately address objects through
   * sub-collections, and the mapping lookups are already scoped by
   * `applicationId`/`calendarId`. What is not allowed is a `..` component or a
   * backslash separator: `URL` normalises a literal `..` out of a pathname but
   * not `%2e%2e`, so a traversal that survived decoding would ride into the
   * mapping DAO and on into anything that later joins an href into a path.
   */
  private static isContainedObjectHref(objectHref: string): boolean {
    if (!objectHref || objectHref.includes('\\')) return false;
    return !objectHref.split('/').some((segment) => segment === '.' || segment === '..');
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
      case 413:
        return 'Payload Too Large';
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

  /**
   * Escape text for XML character data.
   *
   * Code points XML 1.0 forbids outright are dropped rather than escaped:
   * `&#x0B;` is just as unparseable as a literal vertical tab, and there is no
   * numeric escape a client can recover either. Outlook's HTML entity decoding
   * turns `&#11;` in a meeting body into exactly such a character, so a single
   * event could otherwise make the whole Multi-Status document unparseable.
   */
  private static escape(value: string): string {
    return CalDavUtil.stripXmlIllegalCharacters(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private static stripXmlIllegalCharacters(value: string): string {
     
    return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }

  private static unescapeXml(value: string): string {
    return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
}

export { CalDavUtil };
export type { DavCalendarObjectResult, DavPath, DavPropfindRequest, DavReportRequest, DavTimeRange };
