/**
 * Parsing of the request bodies a CalDAV client sends.
 *
 * Everything here reads untrusted XML. The two things that matter most are
 * enforced by `DavXmlScanner`, which parses in a single forward pass so
 * malformed input cannot drive backtracking, and which reports only names it
 * could read as well-formed XML names -- because those names are echoed back
 * into the response as *element names*, where escaping cannot help.
 */

import { BadRequestError } from '@caldav-bridge/backend-errors';
import { allElementTexts, attributeValue, directChildNames, firstElementName, parseDavXml } from './DavXmlScanner';
import { unescapeXml } from './DavXmlUtil';

type DavPropMode = 'allprop' | 'prop' | 'propname';
type DavReportKind = 'calendar-query' | 'calendar-multiget' | 'sync-collection' | 'unknown';

interface DavTimeRange {
  start?: string | undefined;
  end?: string | undefined;
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

const REPORT_KINDS: ReadonlySet<string> = new Set(['calendar-query', 'calendar-multiget', 'sync-collection']);

class DavRequestParser {
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
    return { mode: 'prop', properties: [...new Set(directChildNames(body, 'prop').filter(Boolean))] };
  }

  /**
   * Parse a REPORT body.
   *
   * A `calendar-query` filter is validated here rather than partially ignored.
   * Only `VCALENDAR/VEVENT` with an optional `time-range` is evaluable; a
   * filter on `VALARM`, a `text-match`, or a component this server does not
   * model would otherwise be dropped and the server would return events that do
   * *not* match what the client asked for, which RFC 4791 §7.8 forbids.
   */
  public static parseReport(body: string): DavReportRequest {
    const rootName = firstElementName(body);
    const type = REPORT_KINDS.has(rootName) ? (rootName as DavReportKind) : 'unknown';
    const filter = type === 'calendar-query' ? DavRequestParser.parseQueryFilter(body) : undefined;
    return {
      type,
      properties: [...new Set(directChildNames(body, 'prop').filter(Boolean))],
      hrefs: allElementTexts(body, 'href', unescapeXml),
      syncToken: DavRequestParser.extractSyncToken(body),
      timeRange: filter?.timeRange,
      unsupportedFilter: filter?.unsupported,
    };
  }

  /**
   * The request's sync token, from `<D:sync>` or the report root.
   *
   * Only direct children count. Taking the first `sync-token` anywhere in the
   * body would pick up a property of the same name requested inside `<D:prop>`
   * and use it as the client's position. RFC 4791 §7.2 places it under
   * `<D:sync>`, but the report root is accepted too because clients send it
   * there and it is unambiguous there.
   */
  private static extractSyncToken(xml: string): string | undefined {
    const document = parseDavXml(xml);
    for (let index = 0; index < document.tags.length; index += 1) {
      const tag = document.tags[index];
      if (tag?.closing || (tag?.localName !== 'sync' && index !== 0)) continue;
      for (const child of document.tags) {
        if (child.closing || child.parent !== index || child.localName !== 'sync-token') continue;
        const text = unescapeXml(document.source.slice(child.contentStart, child.contentEnd).trim());
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
    if (attributeValue(calendarFilter.attributes, 'name') !== 'VCALENDAR') return { unsupported: 'unsupported calendar component' };

    for (const child of document.tags.filter((tag) => !tag.closing && tag.parent === calendarIndex)) {
      const childIndex = document.tags.indexOf(child);
      if (child.localName !== 'comp-filter') return { unsupported: `unsupported filter element: ${child.localName}` };
      if (attributeValue(child.attributes, 'name') !== 'VEVENT') return { unsupported: 'unsupported event component' };
      for (const leaf of document.tags.filter((tag) => !tag.closing && tag.parent === childIndex)) {
        if (leaf.localName !== 'time-range') return { unsupported: `unsupported filter element: ${leaf.localName}` };
      }
      const timeRange = DavRequestParser.extractTimeRange(document.source.slice(child.contentStart, child.contentEnd));
      if (timeRange) return { timeRange };
    }
    return {};
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
    const document = parseDavXml(xml);
    const range = document.tags.find((tag) => !tag.closing && tag.localName === 'time-range');
    if (!range) return undefined;
    const start = DavRequestParser.dateTimeFromICal(attributeValue(range.attributes, 'start'));
    const end = DavRequestParser.dateTimeFromICal(attributeValue(range.attributes, 'end'));
    if (DavRequestParser.isUnparseableBound(start) || DavRequestParser.isUnparseableBound(end))
      throw new BadRequestError('time-range bound is not a valid date or date-time.');
    if (start && end && new Date(start).getTime() > new Date(end).getTime())
      throw new BadRequestError('time-range start must not be after its end.');
    return { start, end };
  }

  private static isUnparseableBound(value: string | undefined): boolean {
    return value !== undefined && Number.isNaN(new Date(value).getTime());
  }

  /**
   * Normalise an iCalendar date or date-time to an ISO instant.
   *
   * RFC 4791 requires UTC date-times, but DATE values (`20260501`) are also
   * legal to receive, so each is rewritten into something `Date` parses.
   * Anything unrecognised is returned as-is for the caller to reject, rather
   * than being coerced into a plausible instant.
   */
  private static dateTimeFromICal(value?: string | undefined): string | undefined {
    if (!value) return undefined;
    const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T00:00:00Z`;
    const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value);
    if (!dateTime) return value;
    return `${dateTime[1]}-${dateTime[2]}-${dateTime[3]}T${dateTime[4]}:${dateTime[5]}:${dateTime[6]}Z`;
  }
}

export { DavRequestParser };
export type { DavPropMode, DavPropfindRequest, DavReportKind, DavReportRequest, DavTimeRange };
