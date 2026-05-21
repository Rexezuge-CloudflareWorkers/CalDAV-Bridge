import type { CalendarEvent } from '@caldav-bridge/shared/model';

class ICalendarUtil {
  public static toICS(event: CalendarEvent): string {
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//CalDAV Bridge//CalDAV Bridge//EN',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      `UID:${ICalendarUtil.escape(event.uid)}`,
      `DTSTAMP:${ICalendarUtil.toUtcStamp(event.updated || event.created || new Date().toISOString())}`,
      ...(event.created ? [`CREATED:${ICalendarUtil.toUtcStamp(event.created)}`] : []),
      ...(event.updated ? [`LAST-MODIFIED:${ICalendarUtil.toUtcStamp(event.updated)}`] : []),
      ...(event.summary ? [`SUMMARY:${ICalendarUtil.escape(event.summary)}`] : []),
      ...(event.description ? [`DESCRIPTION:${ICalendarUtil.escape(event.description)}`] : []),
      ...(event.location ? [`LOCATION:${ICalendarUtil.escape(event.location)}`] : []),
      ...(event.status ? [`STATUS:${event.status.toUpperCase()}`] : []),
      ICalendarUtil.dateLine('DTSTART', event.start),
      ICalendarUtil.dateLine('DTEND', event.end),
      ...(event.recurrence || []),
      ...(event.attendees || []).map((attendee) => `ATTENDEE;CN=${ICalendarUtil.escapeParam(attendee.name || attendee.email)}:mailto:${attendee.email}`),
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ];
    return ICalendarUtil.foldLines(lines).join('\r\n');
  }

  public static fromICS(ics: string, fallbackUid: string): CalendarEvent {
    const unfolded = ics.replace(/\r?\n[ \t]/g, '');
    const lines = unfolded.split(/\r?\n/);
    const get = (name: string): string | undefined => {
      const prefix = `${name}`;
      const line = lines.find((item) => item.toUpperCase().startsWith(prefix));
      if (!line) return undefined;
      const index = line.indexOf(':');
      return index >= 0 ? ICalendarUtil.unescape(line.slice(index + 1)) : undefined;
    };
    const start = ICalendarUtil.parseDateLine(lines, 'DTSTART');
    const end = ICalendarUtil.parseDateLine(lines, 'DTEND');
    const recurrence = lines.filter((line) => /^RRULE|^EXDATE/i.test(line)).map((line) => line.trim());
    return {
      uid: get('UID') || fallbackUid,
      summary: get('SUMMARY'),
      description: get('DESCRIPTION'),
      location: get('LOCATION'),
      status: get('STATUS')?.toLowerCase(),
      start,
      end,
      recurrence: recurrence.length ? recurrence : undefined,
    };
  }

  public static eventHref(event: CalendarEvent): string {
    const source = event.id || event.uid || crypto.randomUUID();
    return `${encodeURIComponent(source.replace(/[^a-zA-Z0-9_.-]/g, '-'))}.ics`;
  }

  private static dateLine(name: string, value: CalendarEvent['start']): string {
    if (value.date) return `${name};VALUE=DATE:${value.date.replace(/-/g, '')}`;
    return `${name}:${ICalendarUtil.toUtcStamp(value.dateTime || new Date().toISOString())}`;
  }

  private static parseDateLine(lines: string[], name: string): CalendarEvent['start'] {
    const line = lines.find((item) => item.toUpperCase().startsWith(name));
    if (!line) return { dateTime: new Date().toISOString(), timeZone: 'UTC' };
    const value = line.slice(line.indexOf(':') + 1);
    if (/VALUE=DATE/i.test(line)) return { date: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` };
    return { dateTime: ICalendarUtil.fromUtcStamp(value), timeZone: 'UTC' };
  }

  private static toUtcStamp(value: string): string {
    return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }

  private static fromUtcStamp(value: string): string {
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value);
    return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z` : value;
  }

  private static escape(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  }

  private static unescape(value: string): string {
    return value.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
  }

  private static escapeParam(value: string): string {
    return `"${value.replace(/\^/g, '^^').replace(/\r\n|\r|\n/g, '^n').replace(/"/g, "^'")}"`;
  }

  private static foldLines(lines: string[]): string[] {
    return lines.flatMap((line) => {
      if (line.length <= 75) return [line];
      const folded: string[] = [];
      let remaining = line;
      folded.push(remaining.slice(0, 75));
      remaining = remaining.slice(75);
      while (remaining.length > 0) {
        folded.push(` ${remaining.slice(0, 74)}`);
        remaining = remaining.slice(74);
      }
      return folded;
    });
  }
}

export { ICalendarUtil };
