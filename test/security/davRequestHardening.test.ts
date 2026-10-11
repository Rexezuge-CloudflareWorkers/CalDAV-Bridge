import { describe, expect, it } from 'vitest';
import { DavPathUtil, DavRequestParser, DavResponseBuilder, ICalendarUtil } from '@caldav-bridge/backend-services/calendar';
import { BadRequestError } from '@rexezuge/errors';

/**
 * Regression cover for the DAV request-handling defects fixed together in the
 * security-hardening pass. Each case here failed before the fix and is kept
 * because the underlying behaviour is subtle enough to regress silently.
 */
describe('DAV request hardening', () => {
  describe('malformed percent-escapes', () => {
    // `decodeURIComponent` throws `URIError` on a bad escape. Uncaught, that
    // reached the client as a 500 carrying the raw V8 message; a broken request
    // target is a client error and belongs at 400.
    it.each(['/dav/calendars/app-1/cal-1/%zz.ics', '/dav/calendars/app-1/cal-1/%E0%A4%A.ics', '/dav/calendars/%/cal-1/event.ics'])(
      'reports %s as an invalid path rather than throwing',
      (pathname) => {
        expect(DavPathUtil.parsePath(pathname)).toEqual({ resource: 'invalid' });
      },
    );

    it('reports a malformed bare href as unresolvable', () => {
      expect(DavPathUtil.objectHrefFromDavHref('%zz.ics', 'app-1', 'cal-1')).toBeUndefined();
    });

    it('does not throw for a malformed provider event id', () => {
      expect(() => DavPathUtil.providerEventIdFromObjectHref('%zz.ics')).not.toThrow();
    });
  });

  describe('href containment', () => {
    // `new URL` normalises a literal `..` out of a pathname but leaves `%2e%2e`
    // alone, so a traversal survived decoding and rode into the mapping DAO.
    it('rejects percent-encoded traversal', () => {
      expect(DavPathUtil.parsePath('/dav/calendars/app-1/cal-1/%2e%2e%2f%2e%2e%2fetc/x.ics')).toEqual({ resource: 'invalid' });
      expect(DavPathUtil.parsePath('/dav/calendars/app-1/cal-1/..%2fx.ics')).toEqual({ resource: 'invalid' });
    });

    it('rejects literal traversal and backslash separators', () => {
      expect(DavPathUtil.parsePath('/dav/calendars/app-1/cal-1/../x.ics')).toEqual({ resource: 'invalid' });
      expect(DavPathUtil.parsePath('/dav/calendars/app-1/cal-1/a%5Cb.ics')).toEqual({ resource: 'invalid' });
    });

    // A bare relative href previously became an objectHref with no check at all.
    it('rejects traversal in a bare relative href', () => {
      expect(DavPathUtil.objectHrefFromDavHref('../../etc/x.ics', 'app-1', 'cal-1')).toBeUndefined();
      expect(DavPathUtil.objectHrefFromDavHref('%2e%2e%2f%2e%2e%2fetc%2fx.ics', 'app-1', 'cal-1')).toBeUndefined();
    });

    it('still accepts legitimate nested and encoded hrefs', () => {
      expect(DavPathUtil.parsePath('/dav/calendars/app-1/cal-1/nested%2Fevent.ics')).toEqual({
        resource: 'object',
        applicationId: 'app-1',
        calendarId: 'cal-1',
        objectHref: 'nested/event.ics',
      });
      expect(DavPathUtil.objectHrefFromDavHref('nested%2Fevent.ics', 'app-1', 'cal-1')).toBe('nested/event.ics');
    });
  });

  describe('response XML well-formedness', () => {
    // Property names arrive from the client and are written back as element
    // names, where escaping cannot help. A name containing `&` or `<` produced
    // markup a strict parser rejects -- taking the whole 207 document with it,
    // including every legitimate result.
    it('does not emit client-controlled markup as element names', async () => {
      const response = DavResponseBuilder.propfindCalendarHome(
        'app-1',
        [],
        DavRequestParser.parsePropfind('<D:propfind><D:prop><foo&bar/><a&<b/><x"y/></D:prop></D:propfind>'),
        0,
      );

      const body = await response.text();
      expect(body).not.toContain('foo&bar');
      expect(body).not.toContain('a&<b');
      expect(body).not.toContain('x"y');
      // Every emitted name is a well-formed XML name.
      for (const match of body.matchAll(/<[A-Za-z_:][^/>]*\/>/g)) {
        expect(match[0]).toMatch(/^<[A-Za-z_][\w.-]*:[A-Za-z_][\w.-]*\/>$/);
      }
    });

    // XML 1.0 forbids these code points outright, and Outlook's HTML entity
    // decoding turns `&#11;` in a meeting body into exactly one of them.
    it('strips code points XML forbids from event text', async () => {
      const event = {
        uid: 'event-1',
        summary: 'before\u000B\f\bafter\u0000\u001F',
        start: { dateTime: '2026-01-01T00:00:00Z', timeZone: 'UTC' },
        end: { dateTime: '2026-01-01T01:00:00Z', timeZone: 'UTC' },
      };

      const body = await DavResponseBuilder.propfindObject('app-1', 'cal-1', 'event-1.ics', event, {
        mode: 'prop',
        properties: ['calendar-data'],
      }).text();

      expect(body).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
      expect(body).toContain('before');
      expect(body).toContain('after');
    });
  });

  describe('PUT body validation', () => {
    // `fromICS` used to fall through to a "now" default for a missing DTSTART,
    // so PUT of arbitrary text parsed into a valid event and was written to the
    // user's real provider calendar.
    it('rejects a body that is not a calendar', () => {
      expect(() => ICalendarUtil.fromICS('not a calendar', 'fallback-uid')).toThrow(BadRequestError);
    });

    it('rejects a VCALENDAR with no VEVENT', () => {
      expect(() => ICalendarUtil.fromICS('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR', 'fallback-uid')).toThrow(BadRequestError);
    });

    it('rejects a VEVENT with no VCALENDAR wrapper', () => {
      const body = 'BEGIN:VEVENT\r\nUID:event-1\r\nDTSTART:20260101T000000Z\r\nEND:VEVENT';
      expect(() => ICalendarUtil.fromICS(body, 'fallback-uid')).toThrow(BadRequestError);
    });

    it('rejects a body carrying more than one VEVENT', () => {
      const body = [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:a',
        'DTSTART:20260101T000000Z',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:b',
        'DTSTART:20260102T000000Z',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n');
      expect(() => ICalendarUtil.fromICS(body, 'fallback-uid')).toThrow(BadRequestError);
    });

    it('rejects a VEVENT with no DTSTART', () => {
      const body = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:event-1', 'SUMMARY:No start', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
      expect(() => ICalendarUtil.fromICS(body, 'fallback-uid')).toThrow(BadRequestError);
    });

    it('still parses a well-formed event', () => {
      const body = [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:event-1',
        'DTSTART:20260101T000000Z',
        'SUMMARY:Valid',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n');

      const event = ICalendarUtil.fromICS(body, 'fallback-uid');

      expect(event.uid).toBe('event-1');
      expect(event.summary).toBe('Valid');
      expect(event.start.dateTime).toBe('2026-01-01T00:00:00Z');
    });
  });
});
