import { InternalServerError } from '@caldav-bridge/backend-errors';
import type { CalendarEvent, ProviderCalendar } from '@caldav-bridge/shared/model';
import { fetchProviderJson } from './BaseCalendarHttp';

class GoogleCalendarProviderUtil {
  public static async getProfile(accessToken: string): Promise<{ emailAddress: string }> {
    const data = await fetchProviderJson<{ email?: string }>('https://www.googleapis.com/oauth2/v2/userinfo', accessToken);
    if (!data.email) throw new InternalServerError('Google profile did not include an email address.');
    return { emailAddress: data.email };
  }

  public static async listCalendars(accessToken: string): Promise<ProviderCalendar[]> {
    const calendars: GoogleCalendar[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
      url.searchParams.set('maxResults', '250');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const data = await fetchProviderJson<{ items?: GoogleCalendar[]; nextPageToken?: string }>(url.toString(), accessToken);
      calendars.push(...(data.items || []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return calendars.map((item) => ({ id: item.id, name: item.summary || item.id, description: item.description, timeZone: item.timeZone, readOnly: item.accessRole === 'reader', etag: item.etag }));
  }

  public static async listEvents(accessToken: string, calendarId: string, range: CalendarEventRange = {}): Promise<CalendarEvent[]> {
    const events: GoogleEvent[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
      url.searchParams.set('singleEvents', 'false');
      url.searchParams.set('maxResults', '2500');
      if (range.start) url.searchParams.set('timeMin', range.start);
      if (range.end) url.searchParams.set('timeMax', range.end);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const data = await fetchProviderJson<{ items?: GoogleEvent[]; nextPageToken?: string }>(url.toString(), accessToken);
      events.push(...(data.items || []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return events.map(GoogleCalendarProviderUtil.fromGoogleEvent);
  }

  public static async getEvent(accessToken: string, calendarId: string, eventId: string): Promise<CalendarEvent> {
    return GoogleCalendarProviderUtil.fromGoogleEvent(
      await fetchProviderJson<GoogleEvent>(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, accessToken),
    );
  }

  public static async upsertEvent(accessToken: string, calendarId: string, event: CalendarEvent, providerEventId?: string): Promise<CalendarEvent> {
    const url = providerEventId
      ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(providerEventId)}`
      : `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
    const data = await fetchProviderJson<GoogleEvent>(url, accessToken, {
      method: providerEventId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(GoogleCalendarProviderUtil.toGoogleEvent(event)),
    });
    return GoogleCalendarProviderUtil.fromGoogleEvent(data);
  }

  public static async deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    const response = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok && response.status !== 404 && response.status !== 410)
      throw new InternalServerError(`Calendar provider delete failed (${response.status}): ${await response.text()}`);
  }

  public static fromGoogleEvent(event: GoogleEvent): CalendarEvent {
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

  public static toGoogleEvent(event: CalendarEvent): Partial<GoogleEvent> {
    return {
      summary: event.summary,
      description: event.description,
      location: event.location,
      status: event.status,
      start: event.start,
      end: event.end,
      recurrence: event.recurrence,
      reminders: GoogleCalendarProviderUtil.toGoogleReminders(event.alarms),
    };
  }

  private static toGoogleReminders(alarms?: CalendarEvent['alarms']): { useDefault: boolean; overrides?: Array<{ method: 'popup'; minutes: number }> } {
    if (!alarms?.length) return { useDefault: false };
    return { useDefault: false, overrides: alarms.map((alarm) => ({ method: 'popup' as const, minutes: Math.max(0, Math.trunc(alarm.triggerMinutesBeforeStart)) })) };
  }
}

interface CalendarEventRange { start?: string | undefined; end?: string | undefined }
interface GoogleCalendar { id: string; summary?: string; description?: string; timeZone?: string; accessRole?: string; etag?: string }
interface GoogleEvent { id?: string; iCalUID?: string; etag?: string; summary?: string; description?: string; location?: string; status?: string; start?: { date?: string; dateTime?: string; timeZone?: string }; end?: { date?: string; dateTime?: string; timeZone?: string }; created?: string; updated?: string; recurrence?: string[]; attendees?: Array<{ email: string; displayName?: string }>; reminders?: { useDefault: boolean; overrides?: Array<{ method: 'popup'; minutes: number }> } }

export { GoogleCalendarProviderUtil };
export type { CalendarEventRange, GoogleCalendar, GoogleEvent };
