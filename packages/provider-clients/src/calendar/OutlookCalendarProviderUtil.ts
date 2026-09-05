import { InternalServerError } from '@caldav-bridge/backend-errors';
import type { CalendarEvent, ProviderCalendar } from '@caldav-bridge/shared/model';
import { fetchGraphPages, fetchProviderJson } from './BaseCalendarHttp';
import type { CalendarEventRange } from './GoogleCalendarProviderUtil';

class OutlookCalendarProviderUtil {
  public static readonly graphTextBodyRequest: RequestInit = { headers: { Prefer: 'outlook.body-content-type="text"' } };

  public static async getProfile(accessToken: string): Promise<{ emailAddress: string }> {
    const data = await fetchProviderJson<{ mail?: string | null; userPrincipalName?: string | null }>(
      'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName',
      accessToken,
    );
    const emailAddress = data.mail || data.userPrincipalName || undefined;
    if (!emailAddress) throw new InternalServerError('Microsoft Graph profile did not include an email address.');
    return { emailAddress };
  }

  public static async listCalendars(accessToken: string): Promise<ProviderCalendar[]> {
    const calendars = await fetchGraphPages<GraphCalendar>('https://graph.microsoft.com/v1.0/me/calendars?$top=100', accessToken);
    return calendars.map((item) => ({ id: item.id, name: item.name || item.id, readOnly: !item.canEdit, etag: item.changeKey }));
  }

  public static async listEvents(accessToken: string, calendarId: string): Promise<CalendarEvent[]> {
    const url = `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events?$top=250`;
    const events = await fetchGraphPages<GraphEvent>(url, accessToken, OutlookCalendarProviderUtil.graphTextBodyRequest);
    return events.map(OutlookCalendarProviderUtil.fromGraphEvent);
  }

  public static async listRecurrenceOverrides(
    accessToken: string,
    calendarId: string,
    graphEvents: GraphEvent[],
    events: CalendarEvent[],
    range: Required<CalendarEventRange>,
  ): Promise<Set<string>> {
    const byId = new Map(events.map((event) => [event.id, event]));
    const recurringEventIdsInRange = new Set<string>();
    await Promise.all(
      graphEvents
        .filter((event) => event.type === 'seriesMaster' && event.id)
        .map(async (master) => {
          const event = byId.get(master.id);
          if (!event) return;
          const url = `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(master.id || '')}/instances?startDateTime=${encodeURIComponent(range.start)}&endDateTime=${encodeURIComponent(range.end)}&$top=250`;
          const instances = await fetchGraphPages<GraphEvent>(url, accessToken, OutlookCalendarProviderUtil.graphTextBodyRequest);
          if (instances.length) recurringEventIdsInRange.add(master.id || '');
          const overrides = instances
            .filter((instance) => instance.type === 'exception' && instance.originalStart)
            .map((instance) => ({
              ...OutlookCalendarProviderUtil.fromGraphEvent(instance),
              uid: event.uid,
              recurrenceId: { dateTime: instance.originalStart, timeZone: 'UTC' },
              recurrence: undefined,
            }));
          if (overrides.length) event.overrides = overrides;
        }),
    );
    return recurringEventIdsInRange;
  }

  public static async listRawEvents(accessToken: string, calendarId: string): Promise<GraphEvent[]> {
    const url = `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events?$top=250`;
    return fetchGraphPages<GraphEvent>(url, accessToken, OutlookCalendarProviderUtil.graphTextBodyRequest);
  }

  public static async getEvent(accessToken: string, calendarId: string, eventId: string): Promise<CalendarEvent> {
    return OutlookCalendarProviderUtil.fromGraphEvent(
      await fetchProviderJson<GraphEvent>(`https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, accessToken, OutlookCalendarProviderUtil.graphTextBodyRequest),
    );
  }

  public static async upsertEvent(accessToken: string, calendarId: string, event: CalendarEvent, providerEventId?: string): Promise<CalendarEvent> {
    const url = providerEventId
      ? `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(providerEventId)}`
      : `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events`;
    const data = await fetchProviderJson<GraphEvent>(url, accessToken, {
      method: providerEventId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(OutlookCalendarProviderUtil.toGraphEvent(event)),
    });
    return OutlookCalendarProviderUtil.fromGraphEvent(data);
  }

  public static async deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
    const url = `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    const response = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok && response.status !== 404 && response.status !== 410)
      throw new InternalServerError(`Calendar provider delete failed (${response.status}): ${await response.text()}`);
  }

  public static fromGraphEvent(event: GraphEvent): CalendarEvent {
    return {
      id: event.id,
      uid: event.iCalUId || `${event.id}@microsoft-outlook-calendar`,
      etag: event.changeKey || event['@odata.etag'],
      recurrenceId: event.originalStart ? { dateTime: event.originalStart, timeZone: 'UTC' } : undefined,
      summary: event.subject,
      description: OutlookCalendarProviderUtil.fromGraphDescription(event.body),
      location: event.location?.displayName,
      status: event.isCancelled ? 'cancelled' : 'confirmed',
      start: { dateTime: event.start?.dateTime, timeZone: event.start?.timeZone },
      end: { dateTime: event.end?.dateTime, timeZone: event.end?.timeZone },
      created: event.createdDateTime,
      updated: event.lastModifiedDateTime,
      recurrence: OutlookCalendarProviderUtil.fromGraphRecurrence(event.recurrence),
      attendees: event.attendees?.map((attendee) => ({ email: attendee.emailAddress?.address || '', name: attendee.emailAddress?.name })).filter((attendee) => attendee.email),
      alarms: OutlookCalendarProviderUtil.fromGraphReminder(event),
    };
  }

  public static toGraphEvent(event: CalendarEvent): Partial<GraphEvent> {
    return {
      subject: event.summary,
      body: { contentType: 'text', content: event.description || '' },
      location: event.location ? { displayName: event.location } : undefined,
      start: OutlookCalendarProviderUtil.toGraphDateTime(event.start),
      end: OutlookCalendarProviderUtil.toGraphDateTime(event.end),
      attendees: event.attendees?.map((attendee) => ({ emailAddress: { address: attendee.email, name: attendee.name }, type: 'required' })),
      isReminderOn: event.alarms ? event.alarms.length > 0 : false,
      reminderMinutesBeforeStart: event.alarms?.[0]?.triggerMinutesBeforeStart ?? undefined,
    };
  }

  private static fromGraphReminder(event: GraphEvent): CalendarEvent['alarms'] {
    const minutes = event.reminderMinutesBeforeStart;
    if (!event.isReminderOn || typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) return undefined;
    return [{ triggerMinutesBeforeStart: Math.trunc(minutes), description: event.subject || undefined }];
  }

  private static fromGraphRecurrence(recurrence?: GraphPatternedRecurrence | null | undefined): string[] | undefined {
    const pattern = recurrence?.pattern;
    const range = recurrence?.range;
    if (!pattern?.type) return undefined;

    const parts: string[] = [];
    const frequency = OutlookCalendarProviderUtil.graphFrequency(pattern.type);
    if (!frequency) return undefined;
    parts.push(`FREQ=${frequency}`);

    if (pattern.interval && pattern.interval > 0) parts.push(`INTERVAL=${pattern.interval}`);

    const byDay = OutlookCalendarProviderUtil.graphByDay(pattern);
    if (byDay) parts.push(`BYDAY=${byDay}`);
    if ((pattern.type === 'absoluteMonthly' || pattern.type === 'absoluteYearly') && pattern.dayOfMonth)
      parts.push(`BYMONTHDAY=${pattern.dayOfMonth}`);
    if ((pattern.type === 'absoluteYearly' || pattern.type === 'relativeYearly') && pattern.month) parts.push(`BYMONTH=${pattern.month}`);

    const weekStart = OutlookCalendarProviderUtil.graphDayToICal(pattern.firstDayOfWeek);
    if (pattern.type === 'weekly' && weekStart) parts.push(`WKST=${weekStart}`);

    if (range?.type === 'numbered' && range.numberOfOccurrences && range.numberOfOccurrences > 0)
      parts.push(`COUNT=${range.numberOfOccurrences}`);
    if (range?.type === 'endDate' && range.endDate) parts.push(`UNTIL=${OutlookCalendarProviderUtil.endDateToUtcStamp(range.endDate)}`);

    return [`RRULE:${parts.join(';')}`];
  }

  private static fromGraphDescription(body?: GraphEvent['body'] | undefined): string | undefined {
    if (body?.content === undefined) return undefined;
    if (body.contentType?.toLowerCase() !== 'html') return body.content;
    return OutlookCalendarProviderUtil.unwrapExchangePlainTextHtml(body.content) ?? body.content;
  }

  private static unwrapExchangePlainTextHtml(content: string, depth = 0): string | undefined {
    if (depth > 4 || !/converted from text|\bPlainText\b/i.test(content)) return undefined;
    const plainText = OutlookCalendarProviderUtil.extractPlainTextDiv(content);
    if (plainText === undefined) return undefined;
    const decoded = OutlookCalendarProviderUtil.decodeHtmlEntities(
      plainText
        .replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(/<\/(?:div|p)>/gi, '\n')
        .replace(/<[^>]+>/g, ''),
    )
      .replace(/\r\n?/g, '\n')
      .trim();
    return OutlookCalendarProviderUtil.unwrapExchangePlainTextHtml(decoded, depth + 1) ?? decoded.replace(/[<>]/g, '');
  }

  private static extractPlainTextDiv(content: string): string | undefined {
    return /<div\b(?=[^>]*\bPlainText\b)[^>]*>([\s\S]*?)<\/div>/i.exec(content)?.[1];
  }

  private static decodeHtmlEntities(value: string): string {
    const namedEntities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
      if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
      return namedEntities[name.toLowerCase()] ?? entity;
    });
  }

  private static graphFrequency(type: string): string | undefined {
    switch (type) {
      case 'daily':
        return 'DAILY';
      case 'weekly':
        return 'WEEKLY';
      case 'absoluteMonthly':
      case 'relativeMonthly':
        return 'MONTHLY';
      case 'absoluteYearly':
      case 'relativeYearly':
        return 'YEARLY';
      default:
        return undefined;
    }
  }

  private static graphByDay(pattern: GraphRecurrencePattern): string | undefined {
    const days = (pattern.daysOfWeek || [])
      .map((day) => OutlookCalendarProviderUtil.graphDayToICal(day))
      .filter((day): day is string => Boolean(day));
    if (!days.length) return undefined;
    if (pattern.type === 'weekly') return days.join(',');
    if (pattern.type !== 'relativeMonthly' && pattern.type !== 'relativeYearly') return undefined;
    const ordinal = OutlookCalendarProviderUtil.graphWeekIndex(pattern.index || 'first');
    return ordinal ? `${ordinal}${days[0]}` : days[0];
  }

  private static graphDayToICal(day?: string | undefined): string | undefined {
    switch (day) {
      case 'sunday':
        return 'SU';
      case 'monday':
        return 'MO';
      case 'tuesday':
        return 'TU';
      case 'wednesday':
        return 'WE';
      case 'thursday':
        return 'TH';
      case 'friday':
        return 'FR';
      case 'saturday':
        return 'SA';
      default:
        return undefined;
    }
  }

  private static graphWeekIndex(index?: string | undefined): string | undefined {
    switch (index) {
      case 'first':
        return '1';
      case 'second':
        return '2';
      case 'third':
        return '3';
      case 'fourth':
        return '4';
      case 'last':
        return '-1';
      default:
        return undefined;
    }
  }

  private static endDateToUtcStamp(value: string): string {
    return new Date(`${value}T23:59:59Z`)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
  }

  private static toGraphDateTime(value: CalendarEvent['start']): GraphDateTimeTimeZone {
    const timeZone = value.timeZone || 'UTC';
    return { dateTime: OutlookCalendarProviderUtil.toGraphDateTimeValue(value.dateTime || `${value.date || ''}T00:00:00`, timeZone), timeZone: OutlookCalendarProviderUtil.toGraphTimeZone(timeZone) };
  }

  private static toGraphDateTimeValue(value: string, timeZone: string): string {
    if (timeZone === 'UTC') return value;
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) return value;
    return OutlookCalendarProviderUtil.formatInTimeZone(value, timeZone) || value.replace(/[zZ]|[+-]\d{2}:?\d{2}$/, '');
  }

  private static toGraphTimeZone(timeZone: string): string {
    const windowsTimeZone = OutlookCalendarProviderUtil.windowsTimeZones[timeZone];
    return windowsTimeZone || timeZone;
  }

  private static formatInTimeZone(value: string, timeZone: string): string | undefined {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return undefined;
    let parts: Intl.DateTimeFormatPart[];
    try {
      parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).formatToParts(date);
    } catch {
      return undefined;
    }
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
  }

  private static readonly windowsTimeZones: Record<string, string> = {
    'America/Chicago': 'Central Standard Time',
  };
}

interface GraphCalendar { id: string; name?: string; canEdit?: boolean; changeKey?: string }
interface GraphEvent { id?: string; iCalUId?: string; changeKey?: string; '@odata.etag'?: string; subject?: string; body?: { content?: string; contentType?: string }; location?: { displayName?: string }; isCancelled?: boolean; start?: GraphDateTimeTimeZone; end?: GraphDateTimeTimeZone; createdDateTime?: string; lastModifiedDateTime?: string; originalStart?: string; recurrence?: GraphPatternedRecurrence | null; attendees?: Array<{ emailAddress?: { address?: string; name?: string }; type?: string }>; isReminderOn?: boolean; reminderMinutesBeforeStart?: number | null; type?: string; seriesMasterId?: string }
interface GraphDateTimeTimeZone { dateTime?: string; timeZone?: string }
interface GraphPatternedRecurrence { pattern?: GraphRecurrencePattern | undefined; range?: GraphRecurrenceRange | undefined }
interface GraphRecurrencePattern { type?: string | undefined; interval?: number | undefined; daysOfWeek?: string[] | undefined; firstDayOfWeek?: string | undefined; index?: string | undefined; dayOfMonth?: number | undefined; month?: number | undefined }
interface GraphRecurrenceRange { type?: string | undefined; startDate?: string | undefined; endDate?: string | undefined; numberOfOccurrences?: number | undefined; recurrenceTimeZone?: string | undefined }

export { OutlookCalendarProviderUtil };
export type { GraphCalendar, GraphDateTimeTimeZone, GraphEvent, GraphPatternedRecurrence, GraphRecurrencePattern, GraphRecurrenceRange };
