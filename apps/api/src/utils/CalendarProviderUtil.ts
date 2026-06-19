import { PROVIDER_GOOGLE_CALENDAR } from '@caldav-bridge/shared/constants';
import type { ProviderId } from '@caldav-bridge/shared/constants';
import type { CalendarEvent, ProviderCalendar } from '@caldav-bridge/shared/model';
import { HttpError } from './HttpError';

class CalendarProviderUtil {
  private static readonly maxThrottleRetryAttempts = 2;
  private static readonly maxRetryAfterSeconds = 2;
  private static readonly graphTextBodyRequest: RequestInit = { headers: { Prefer: 'outlook.body-content-type="text"' } };

  public static async getProfile(providerId: ProviderId | string, accessToken: string): Promise<{ emailAddress: string }> {
    if (providerId === PROVIDER_GOOGLE_CALENDAR) {
      const data = await CalendarProviderUtil.fetchJson<{ email?: string }>('https://www.googleapis.com/oauth2/v2/userinfo', accessToken);
      if (!data.email) throw new HttpError(502, 'Google profile did not include an email address.');
      return { emailAddress: data.email };
    }
    const data = await CalendarProviderUtil.fetchJson<{ mail?: string | null; userPrincipalName?: string | null }>(
      'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName',
      accessToken,
    );
    const emailAddress = data.mail || data.userPrincipalName || undefined;
    if (!emailAddress) throw new HttpError(502, 'Microsoft Graph profile did not include an email address.');
    return { emailAddress };
  }

  public static async listCalendars(providerId: ProviderId | string, accessToken: string): Promise<ProviderCalendar[]> {
    if (providerId === PROVIDER_GOOGLE_CALENDAR) {
      const calendars: GoogleCalendar[] = [];
      let pageToken: string | undefined;
      do {
        const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
        url.searchParams.set('maxResults', '250');
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const data = await CalendarProviderUtil.fetchJson<{ items?: GoogleCalendar[]; nextPageToken?: string }>(url.toString(), accessToken);
        calendars.push(...(data.items || []));
        pageToken = data.nextPageToken;
      } while (pageToken);
      return calendars.map((item) => ({ id: item.id, name: item.summary || item.id, description: item.description, timeZone: item.timeZone, readOnly: item.accessRole === 'reader', etag: item.etag }));
    }
    const calendars = await CalendarProviderUtil.fetchGraphPages<GraphCalendar>('https://graph.microsoft.com/v1.0/me/calendars?$top=100', accessToken);
    return calendars.map((item) => ({ id: item.id, name: item.name || item.id, readOnly: !item.canEdit, etag: item.changeKey }));
  }

  public static async listEvents(providerId: ProviderId | string, accessToken: string, calendarId: string, range: CalendarEventRange = {}): Promise<CalendarEvent[]> {
    if (providerId === PROVIDER_GOOGLE_CALENDAR) {
      const events: GoogleEvent[] = [];
      let pageToken: string | undefined;
      do {
        const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
        url.searchParams.set('singleEvents', 'false');
        url.searchParams.set('maxResults', '2500');
        if (range.start) url.searchParams.set('timeMin', range.start);
        if (range.end) url.searchParams.set('timeMax', range.end);
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const data = await CalendarProviderUtil.fetchJson<{ items?: GoogleEvent[]; nextPageToken?: string }>(url.toString(), accessToken);
        events.push(...(data.items || []));
        pageToken = data.nextPageToken;
      } while (pageToken);
      return events.map(CalendarProviderUtil.fromGoogleEvent).filter((event) => CalendarProviderUtil.eventOverlapsRange(event, range));
    }
    const url = `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events?$top=250`;
    const events = await CalendarProviderUtil.fetchGraphPages<GraphEvent>(url, accessToken, CalendarProviderUtil.graphTextBodyRequest);
    const mappedEvents = events.map(CalendarProviderUtil.fromGraphEvent);
    const recurringEventIdsInRange = range.start && range.end
      ? await CalendarProviderUtil.addGraphRecurrenceOverrides(accessToken, calendarId, events, mappedEvents, { start: range.start, end: range.end })
      : undefined;
    return mappedEvents.filter((event) => recurringEventIdsInRange?.has(event.id || '') || CalendarProviderUtil.eventOverlapsRange(event, range));
  }

  public static async getEvent(providerId: ProviderId | string, accessToken: string, calendarId: string, eventId: string): Promise<CalendarEvent> {
    if (providerId === PROVIDER_GOOGLE_CALENDAR) {
      return CalendarProviderUtil.fromGoogleEvent(await CalendarProviderUtil.fetchJson<GoogleEvent>(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, accessToken));
    }
    return CalendarProviderUtil.fromGraphEvent(await CalendarProviderUtil.fetchJson<GraphEvent>(`https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, accessToken, CalendarProviderUtil.graphTextBodyRequest));
  }

  public static async upsertEvent(providerId: ProviderId | string, accessToken: string, calendarId: string, event: CalendarEvent, providerEventId?: string): Promise<CalendarEvent> {
    if (providerId === PROVIDER_GOOGLE_CALENDAR) {
      const url = providerEventId
        ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(providerEventId)}`
        : `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
      const data = await CalendarProviderUtil.fetchJson<GoogleEvent>(url, accessToken, {
        method: providerEventId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(CalendarProviderUtil.toGoogleEvent(event)),
      });
      return CalendarProviderUtil.fromGoogleEvent(data);
    }
    const url = providerEventId
      ? `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(providerEventId)}`
      : `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events`;
    const data = await CalendarProviderUtil.fetchJson<GraphEvent>(url, accessToken, {
      method: providerEventId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(CalendarProviderUtil.toGraphEvent(event)),
    });
    return CalendarProviderUtil.fromGraphEvent(data);
  }

  public static async deleteEvent(providerId: ProviderId | string, accessToken: string, calendarId: string, eventId: string): Promise<void> {
    const url = providerId === PROVIDER_GOOGLE_CALENDAR
      ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
      : `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    const response = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok && response.status !== 404 && response.status !== 410) throw new HttpError(502, `Calendar provider delete failed (${response.status}): ${await response.text()}`);
  }

  private static async fetchJson<T>(url: string, accessToken: string, init: RequestInit = {}): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${accessToken}`);
      const response = await fetch(url, { ...init, headers });
      const text = await response.text();
      const data = text ? (CalendarProviderUtil.parseJson<T & { error?: { message?: string } }>(text) ?? ({} as T & { error?: { message?: string } })) : ({} as T & { error?: { message?: string } });
      if (response.ok) return data as T;

      if (response.status === 429 && attempt < CalendarProviderUtil.maxThrottleRetryAttempts) {
        const retryDelay = CalendarProviderUtil.retryDelayMilliseconds(response.headers.get('Retry-After'), attempt);
        if (retryDelay <= CalendarProviderUtil.maxRetryAfterSeconds * 1000) {
          await CalendarProviderUtil.delay(retryDelay);
          continue;
        }
      }

      throw CalendarProviderUtil.providerError(response, text, data);
    }
  }

  private static providerError(response: Response, text: string, data: { error?: { message?: string } }): HttpError {
    const message = `Calendar provider request failed (${response.status}): ${data.error?.message || text || response.statusText}`;
    if (response.status === 404 || response.status === 410) return new HttpError(404, message);
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      return new HttpError(503, message, retryAfter ? { 'Retry-After': retryAfter } : undefined);
    }
    return new HttpError(response.status >= 400 && response.status < 500 ? 400 : 502, message);
  }

  private static retryDelayMilliseconds(retryAfter: string | null, attempt: number): number {
    if (!retryAfter) return 250 * 2 ** attempt;
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const retryAt = new Date(retryAfter).getTime();
    return Number.isNaN(retryAt) ? Number.POSITIVE_INFINITY : Math.max(0, retryAt - Date.now());
  }

  private static delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private static async fetchGraphPages<T>(url: string, accessToken: string, init: RequestInit = {}): Promise<T[]> {
    const items: T[] = [];
    let nextUrl: string | undefined = url;
    while (nextUrl) {
      const data: { value?: T[]; '@odata.nextLink'?: string } = await CalendarProviderUtil.fetchJson(nextUrl, accessToken, init);
      items.push(...(data.value || []));
      nextUrl = data['@odata.nextLink'];
    }
    return items;
  }

  private static async addGraphRecurrenceOverrides(accessToken: string, calendarId: string, graphEvents: GraphEvent[], events: CalendarEvent[], range: Required<CalendarEventRange>): Promise<Set<string>> {
    const byId = new Map(events.map((event) => [event.id, event]));
    const recurringEventIdsInRange = new Set<string>();
    await Promise.all(
      graphEvents
        .filter((event) => event.type === 'seriesMaster' && event.id)
        .map(async (master) => {
          const event = byId.get(master.id);
          if (!event) return;
          const url = `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(master.id || '')}/instances?startDateTime=${encodeURIComponent(range.start)}&endDateTime=${encodeURIComponent(range.end)}&$top=250`;
          const instances = await CalendarProviderUtil.fetchGraphPages<GraphEvent>(url, accessToken, CalendarProviderUtil.graphTextBodyRequest);
          if (instances.length) recurringEventIdsInRange.add(master.id || '');
          const overrides = instances
            .filter((instance) => instance.type === 'exception' && instance.originalStart)
            .map((instance) => ({
              ...CalendarProviderUtil.fromGraphEvent(instance),
              uid: event.uid,
              recurrenceId: { dateTime: instance.originalStart, timeZone: 'UTC' },
              recurrence: undefined,
            }));
          if (overrides.length) event.overrides = overrides;
        }),
    );
    return recurringEventIdsInRange;
  }

  private static parseJson<T>(text: string): T | undefined {
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  }

  private static toGoogleReminders(alarms?: CalendarEvent['alarms']): { useDefault: boolean; overrides?: Array<{ method: 'popup'; minutes: number }> } {
    if (!alarms?.length) return { useDefault: false };
    return { useDefault: false, overrides: alarms.map((alarm) => ({ method: 'popup' as const, minutes: Math.max(0, Math.trunc(alarm.triggerMinutesBeforeStart)) })) };
  }

  private static eventOverlapsRange(event: CalendarEvent, range: CalendarEventRange): boolean {
    if (!range.start && !range.end) return true;
    const eventStart = CalendarProviderUtil.toTime(event.start.dateTime || event.start.date);
    const eventEnd = CalendarProviderUtil.toTime(event.end.dateTime || event.end.date) ?? eventStart;
    const rangeStart = CalendarProviderUtil.toTime(range.start) ?? Number.NEGATIVE_INFINITY;
    const rangeEnd = CalendarProviderUtil.toTime(range.end) ?? Number.POSITIVE_INFINITY;
    if (event.overrides?.some((override) => CalendarProviderUtil.eventOverlapsRange(override, range))) return true;
    if (eventStart === undefined) return true;
    return eventStart < rangeEnd && (eventEnd ?? eventStart) > rangeStart;
  }

  private static toTime(value?: string | undefined): number | undefined {
    if (!value) return undefined;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.getTime();
  }

  private static fromGoogleEvent(event: GoogleEvent): CalendarEvent {
    return {
      id: event.id,
      uid: event.iCalUID || `${event.id}@google-calendar`,
      etag: event.etag,
      summary: event.summary,
      description: event.description,
      location: event.location,
      status: event.status,
      start: event.start || {},
      end: event.end || {},
      created: event.created,
      updated: event.updated,
      recurrence: event.recurrence,
      attendees: event.attendees?.map((attendee) => ({ email: attendee.email, name: attendee.displayName })).filter((attendee) => attendee.email),
    };
  }

  private static toGoogleEvent(event: CalendarEvent): Partial<GoogleEvent> {
    return {
      summary: event.summary,
      description: event.description,
      location: event.location,
      status: event.status,
      start: event.start,
      end: event.end,
      recurrence: event.recurrence,
      reminders: CalendarProviderUtil.toGoogleReminders(event.alarms),
    };
  }

  private static fromGraphEvent(event: GraphEvent): CalendarEvent {
    return {
      id: event.id,
      uid: event.iCalUId || `${event.id}@microsoft-outlook-calendar`,
      etag: event.changeKey || event['@odata.etag'],
      recurrenceId: event.originalStart ? { dateTime: event.originalStart, timeZone: 'UTC' } : undefined,
      summary: event.subject,
      description: CalendarProviderUtil.fromGraphDescription(event.body),
      location: event.location?.displayName,
      status: event.isCancelled ? 'cancelled' : 'confirmed',
      start: { dateTime: event.start?.dateTime, timeZone: event.start?.timeZone },
      end: { dateTime: event.end?.dateTime, timeZone: event.end?.timeZone },
      created: event.createdDateTime,
      updated: event.lastModifiedDateTime,
      recurrence: CalendarProviderUtil.fromGraphRecurrence(event.recurrence),
      attendees: event.attendees?.map((attendee) => ({ email: attendee.emailAddress?.address || '', name: attendee.emailAddress?.name })).filter((attendee) => attendee.email),
      alarms: CalendarProviderUtil.fromGraphReminder(event),
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
    const frequency = CalendarProviderUtil.graphFrequency(pattern.type);
    if (!frequency) return undefined;
    parts.push(`FREQ=${frequency}`);

    if (pattern.interval && pattern.interval > 0) parts.push(`INTERVAL=${pattern.interval}`);

    const byDay = CalendarProviderUtil.graphByDay(pattern);
    if (byDay) parts.push(`BYDAY=${byDay}`);
    if ((pattern.type === 'absoluteMonthly' || pattern.type === 'absoluteYearly') && pattern.dayOfMonth)
      parts.push(`BYMONTHDAY=${pattern.dayOfMonth}`);
    if ((pattern.type === 'absoluteYearly' || pattern.type === 'relativeYearly') && pattern.month) parts.push(`BYMONTH=${pattern.month}`);

    const weekStart = CalendarProviderUtil.graphDayToICal(pattern.firstDayOfWeek);
    if (pattern.type === 'weekly' && weekStart) parts.push(`WKST=${weekStart}`);

    if (range?.type === 'numbered' && range.numberOfOccurrences && range.numberOfOccurrences > 0)
      parts.push(`COUNT=${range.numberOfOccurrences}`);
    if (range?.type === 'endDate' && range.endDate) parts.push(`UNTIL=${CalendarProviderUtil.endDateToUtcStamp(range.endDate)}`);

    return [`RRULE:${parts.join(';')}`];
  }

  private static fromGraphDescription(body?: GraphEvent['body'] | undefined): string | undefined {
    if (body?.content === undefined) return undefined;
    if (body.contentType?.toLowerCase() !== 'html') return body.content;
    return CalendarProviderUtil.unwrapExchangePlainTextHtml(body.content) ?? body.content;
  }

  private static unwrapExchangePlainTextHtml(content: string, depth = 0): string | undefined {
    if (depth > 4 || !/converted from text|\bPlainText\b/i.test(content)) return undefined;
    const plainText = CalendarProviderUtil.extractPlainTextDiv(content);
    if (plainText === undefined) return undefined;
    const decoded = CalendarProviderUtil.decodeHtmlEntities(plainText)
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/(?:div|p)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\r\n?/g, '\n')
      .trim();
    return CalendarProviderUtil.unwrapExchangePlainTextHtml(decoded, depth + 1) ?? decoded;
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
      .map((day) => CalendarProviderUtil.graphDayToICal(day))
      .filter((day): day is string => Boolean(day));
    if (!days.length) return undefined;
    if (pattern.type === 'weekly') return days.join(',');
    if (pattern.type !== 'relativeMonthly' && pattern.type !== 'relativeYearly') return undefined;
    const ordinal = CalendarProviderUtil.graphWeekIndex(pattern.index || 'first');
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

  private static toGraphEvent(event: CalendarEvent): Partial<GraphEvent> {
    return {
      subject: event.summary,
      body: { contentType: 'text', content: event.description || '' },
      location: event.location ? { displayName: event.location } : undefined,
      start: CalendarProviderUtil.toGraphDateTime(event.start),
      end: CalendarProviderUtil.toGraphDateTime(event.end),
      attendees: event.attendees?.map((attendee) => ({ emailAddress: { address: attendee.email, name: attendee.name }, type: 'required' })),
      isReminderOn: event.alarms ? event.alarms.length > 0 : false,
      reminderMinutesBeforeStart: event.alarms?.[0]?.triggerMinutesBeforeStart ?? undefined,
    };
  }

  private static toGraphDateTime(value: CalendarEvent['start']): GraphDateTimeTimeZone {
    const timeZone = value.timeZone || 'UTC';
    return { dateTime: CalendarProviderUtil.toGraphDateTimeValue(value.dateTime || `${value.date || ''}T00:00:00`, timeZone), timeZone: CalendarProviderUtil.toGraphTimeZone(timeZone) };
  }

  private static toGraphDateTimeValue(value: string, timeZone: string): string {
    if (timeZone === 'UTC') return value;
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) return value;
    return CalendarProviderUtil.formatInTimeZone(value, timeZone) || value.replace(/[zZ]|[+-]\d{2}:?\d{2}$/, '');
  }

  private static toGraphTimeZone(timeZone: string): string {
    const windowsTimeZone = CalendarProviderUtil.windowsTimeZones[timeZone];
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

interface CalendarEventRange { start?: string | undefined; end?: string | undefined }
interface GoogleCalendar { id: string; summary?: string; description?: string; timeZone?: string; accessRole?: string; etag?: string }
interface GoogleEvent { id?: string; iCalUID?: string; etag?: string; summary?: string; description?: string; location?: string; status?: string; start?: { date?: string; dateTime?: string; timeZone?: string }; end?: { date?: string; dateTime?: string; timeZone?: string }; created?: string; updated?: string; recurrence?: string[]; attendees?: Array<{ email: string; displayName?: string }>; reminders?: { useDefault: boolean; overrides?: Array<{ method: 'popup'; minutes: number }> } }
interface GraphCalendar { id: string; name?: string; canEdit?: boolean; changeKey?: string }
interface GraphEvent { id?: string; iCalUId?: string; changeKey?: string; '@odata.etag'?: string; subject?: string; body?: { content?: string; contentType?: string }; location?: { displayName?: string }; isCancelled?: boolean; start?: GraphDateTimeTimeZone; end?: GraphDateTimeTimeZone; createdDateTime?: string; lastModifiedDateTime?: string; originalStart?: string; recurrence?: GraphPatternedRecurrence | null; attendees?: Array<{ emailAddress?: { address?: string; name?: string }; type?: string }>; isReminderOn?: boolean; reminderMinutesBeforeStart?: number | null; type?: string; seriesMasterId?: string }
interface GraphDateTimeTimeZone { dateTime?: string; timeZone?: string }
interface GraphPatternedRecurrence { pattern?: GraphRecurrencePattern | undefined; range?: GraphRecurrenceRange | undefined }
interface GraphRecurrencePattern { type?: string | undefined; interval?: number | undefined; daysOfWeek?: string[] | undefined; firstDayOfWeek?: string | undefined; index?: string | undefined; dayOfMonth?: number | undefined; month?: number | undefined }
interface GraphRecurrenceRange { type?: string | undefined; startDate?: string | undefined; endDate?: string | undefined; numberOfOccurrences?: number | undefined; recurrenceTimeZone?: string | undefined }

export { CalendarProviderUtil };
