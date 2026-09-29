/**
 * iCalendar text and the XML escaping around it.
 *
 * Two separate concerns that always travel together: turning an event into
 * iCalendar, and turning arbitrary text into something that can sit inside a
 * DAV response. Both have rules that are easy to violate silently -- an escape
 * that produces invalid XML, or a date that defaults to "now" -- so they live
 * together with tests pointed at them.
 */

import { ICalendarUtil } from './ICalendarUtil';

/** `TextEncoder` is stateless; one instance is enough for measuring bytes. */
const UTF8 = new TextEncoder();

/**
 * The `getlastmodified` value for an event, or the response time when it has no
 * usable date. A collection with no date at all is a provider quirk, and
 * reporting the current time is more useful than emitting an invalid date.
 */
function httpDate(value?: string | undefined): string {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toUTCString() : date.toUTCString();
}

function byteLength(value: string): number {
  return UTF8.encode(value).length;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Escape text for XML character data.
 *
 * Code points XML 1.0 forbids outright are dropped rather than escaped:
 * `&#x0B;` is just as unparseable as a literal vertical tab, and there is no
 * numeric escape a client could recover either. Outlook's HTML entity decoding
 * turns `&#11;` in a meeting body into exactly such a character, so a single
 * event could otherwise make the whole Multi-Status document unparseable.
 */
function escapeXml(value: string): string {
  return stripXmlIllegalCharacters(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stripXmlIllegalCharacters(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** Undo `escapeXml`, plus the named and numeric entities a client may send. */
function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/** The reason phrases DAV embeds in its own `<D:status>` elements. */
function statusText(status: number): string {
  return STATUS_TEXT[status] ?? 'Error';
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  501: 'Not Implemented',
  503: 'Service Unavailable',
};

/** The iCalendar body of an event, for `calendar-data` and `GET`. */
function toIcs(event: Parameters<typeof ICalendarUtil.toICS>[0]): string {
  return ICalendarUtil.toICS(event);
}

export { byteLength, escapeXml, httpDate, statusText, stripXmlIllegalCharacters, toIcs, unescapeXml, unique };
