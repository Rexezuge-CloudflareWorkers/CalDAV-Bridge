import { PROVIDER_GOOGLE_CALENDAR } from '@caldav-bridge/shared/constants';
import type { ProviderId } from '@caldav-bridge/shared/constants';
import type { CalendarEvent, ProviderCalendar } from '@caldav-bridge/shared/model';
import { HttpError } from './HttpError';

class CalendarProviderUtil {
  private static readonly maxThrottleRetryAttempts = 2;
  private static readonly maxRetryAfterSeconds = 2;

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
    const useCalendarView = Boolean(range.start && range.end);
    const url = useCalendarView
      ? `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/calendarView?startDateTime=${encodeURIComponent(range.start || '')}&endDateTime=${encodeURIComponent(range.end || '')}&$top=250`
      : `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events?$top=250`;
    const events = await CalendarProviderUtil.fetchGraphPages<GraphEvent>(url, accessToken);
    return events.map(CalendarProviderUtil.fromGraphEvent).filter((event) => CalendarProviderUtil.eventOverlapsRange(event, range));
  }

  public static async getEvent(providerId: ProviderId | string, accessToken: string, calendarId: string, eventId: string): Promise<CalendarEvent> {
    if (providerId === PROVIDER_GOOGLE_CALENDAR) {
      return CalendarProviderUtil.fromGoogleEvent(await CalendarProviderUtil.fetchJson<GoogleEvent>(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, accessToken));
    }
    return CalendarProviderUtil.fromGraphEvent(await CalendarProviderUtil.fetchJson<GraphEvent>(`https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, accessToken));
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

  private static async fetchGraphPages<T>(url: string, accessToken: string): Promise<T[]> {
    const items: T[] = [];
    let nextUrl: string | undefined = url;
    while (nextUrl) {
      const data: { value?: T[]; '@odata.nextLink'?: string } = await CalendarProviderUtil.fetchJson(nextUrl, accessToken);
      items.push(...(data.value || []));
      nextUrl = data['@odata.nextLink'];
    }
    return items;
  }

  private static parseJson<T>(text: string): T | undefined {
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  }

  private static eventOverlapsRange(event: CalendarEvent, range: CalendarEventRange): boolean {
    if (!range.start && !range.end) return true;
    const eventStart = CalendarProviderUtil.toTime(event.start.dateTime || event.start.date);
    const eventEnd = CalendarProviderUtil.toTime(event.end.dateTime || event.end.date) ?? eventStart;
    const rangeStart = CalendarProviderUtil.toTime(range.start) ?? Number.NEGATIVE_INFINITY;
    const rangeEnd = CalendarProviderUtil.toTime(range.end) ?? Number.POSITIVE_INFINITY;
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
    return { summary: event.summary, description: event.description, location: event.location, status: event.status, start: event.start, end: event.end, recurrence: event.recurrence };
  }

  private static fromGraphEvent(event: GraphEvent): CalendarEvent {
    return {
      id: event.id,
      uid: event.iCalUId || `${event.id}@microsoft-outlook-calendar`,
      etag: event.changeKey || event['@odata.etag'],
      summary: event.subject,
      description: event.body?.content,
      location: event.location?.displayName,
      status: event.isCancelled ? 'cancelled' : 'confirmed',
      start: { dateTime: event.start?.dateTime, timeZone: event.start?.timeZone },
      end: { dateTime: event.end?.dateTime, timeZone: event.end?.timeZone },
      created: event.createdDateTime,
      updated: event.lastModifiedDateTime,
      attendees: event.attendees?.map((attendee) => ({ email: attendee.emailAddress?.address || '', name: attendee.emailAddress?.name })).filter((attendee) => attendee.email),
    };
  }

  private static toGraphEvent(event: CalendarEvent): Partial<GraphEvent> {
    return {
      subject: event.summary,
      body: { contentType: 'text', content: event.description || '' },
      location: event.location ? { displayName: event.location } : undefined,
      start: { dateTime: event.start.dateTime || `${event.start.date || ''}T00:00:00`, timeZone: event.start.timeZone || 'UTC' },
      end: { dateTime: event.end.dateTime || `${event.end.date || ''}T00:00:00`, timeZone: event.end.timeZone || 'UTC' },
      attendees: event.attendees?.map((attendee) => ({ emailAddress: { address: attendee.email, name: attendee.name }, type: 'required' })),
    };
  }
}

interface CalendarEventRange { start?: string | undefined; end?: string | undefined }
interface GoogleCalendar { id: string; summary?: string; description?: string; timeZone?: string; accessRole?: string; etag?: string }
interface GoogleEvent { id?: string; iCalUID?: string; etag?: string; summary?: string; description?: string; location?: string; status?: string; start?: { date?: string; dateTime?: string; timeZone?: string }; end?: { date?: string; dateTime?: string; timeZone?: string }; created?: string; updated?: string; recurrence?: string[]; attendees?: Array<{ email: string; displayName?: string }> }
interface GraphCalendar { id: string; name?: string; canEdit?: boolean; changeKey?: string }
interface GraphEvent { id?: string; iCalUId?: string; changeKey?: string; '@odata.etag'?: string; subject?: string; body?: { content?: string; contentType?: string }; location?: { displayName?: string }; isCancelled?: boolean; start?: { dateTime?: string; timeZone?: string }; end?: { dateTime?: string; timeZone?: string }; createdDateTime?: string; lastModifiedDateTime?: string; attendees?: Array<{ emailAddress?: { address?: string; name?: string }; type?: string }> }

export { CalendarProviderUtil };
