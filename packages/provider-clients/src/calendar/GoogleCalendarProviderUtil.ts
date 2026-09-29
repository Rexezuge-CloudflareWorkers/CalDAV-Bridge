import { InternalServerError } from '@caldav-bridge/backend-errors';
import type { CalendarEvent, ProviderCalendar } from '@caldav-bridge/shared/model';
import { fetchProviderJson } from './BaseCalendarHttp';
import { CalendarProviderUtil } from './CalendarProviderUtil';
import type { CalendarEventRange } from './CalendarProvider';

/** The Google implementation of `ICalendarProvider`, reached only through `CalendarProviderUtil`. */
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
    return calendars.map((item) => ({
      id: item.id,
      name: item.summary || item.id,
      description: item.description,
      timeZone: item.timeZone,
      readOnly: item.accessRole === 'reader',
      etag: item.etag,
    }));
  }

  /**
   * List a calendar's events.
   *
   * `singleEvents=true` is essential rather than incidental. With it false Google
   * returns each recurring series once, with `start`/`end` set to the *first*
   * occurrence, so a weekly meeting that started six months ago appears to end
   * before any recent window. Combined with the range overlap test that dropped
   * every recurring event from any bounded `calendar-query` -- the primary way
   * CalDAV clients populate a calendar view. Expanded instances come back
   * instead, and `regroupRecurringEvents` folds them back into one event with
   * its overrides, which is the shape the rest of the pipeline already expects
   * from Outlook.
   */
  public static async listEvents(accessToken: string, calendarId: string, range: CalendarEventRange = {}): Promise<CalendarEvent[]> {
    const events: GoogleEvent[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('maxResults', '2500');
      if (range.start) url.searchParams.set('timeMin', range.start);
      if (range.end) url.searchParams.set('timeMax', range.end);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const data = await fetchProviderJson<{ items?: GoogleEvent[]; nextPageToken?: string }>(url.toString(), accessToken);
      events.push(...(data.items || []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    // The API's own `timeMin`/`timeMax` is a hint, not a guarantee -- an event
    // overlapping the boundary still comes back -- so the window is also applied
    // here, where a series is judged by any of its occurrences.
    return GoogleCalendarProviderUtil.regroupRecurringEvents(events.map(GoogleCalendarProviderUtil.fromGoogleEvent)).filter((event) =>
      CalendarProviderUtil.eventOverlapsRange(event, range),
    );
  }

  /**
   * Fold expanded instances of a recurring series back into a single event.
   *
   * Google returns one object per occurrence when `singleEvents=true`, tagged
   * with `recurringEventId` and `originalStartTime`. The first occurrence is the
   * series master; the rest become its `overrides`, matching how the Outlook
   * client already presents a series. Without this the bridge would mint a
   * separate CalDAV object per occurrence, and a client would show one event per
   * instance instead of one recurring event.
   */
  public static regroupRecurringEvents(events: CalendarEvent[]): CalendarEvent[] {
    const masters = new Map<string, CalendarEvent>();
    const instances: CalendarEvent[] = [];
    for (const event of events) {
      const seriesId = event.recurringSeriesId;
      if (!seriesId) {
        masters.set(event.uid, event);
        continue;
      }
      instances.push(event);
    }
    // An instance whose master was not returned is promoted, so a partial page
    // does not silently drop it.
    for (const instance of instances) {
      const seriesId = instance.recurringSeriesId as string;
      if (masters.has(seriesId)) continue;
      const promoted: CalendarEvent = { ...instance, recurringSeriesId: undefined, overrides: undefined };
      masters.set(seriesId, promoted);
    }

    const byUid = new Map<string, CalendarEvent>();
    for (const event of masters.values()) byUid.set(event.uid, event);
    for (const instance of instances) {
      const master = byUid.get(instance.recurringSeriesId as string);
      if (!master || master === instance) continue;
      const override: CalendarEvent = { ...instance, uid: master.uid, recurringSeriesId: undefined };
      master.overrides = [...(master.overrides ?? []), override];
    }
    return [...masters.values()].map((master) => GoogleCalendarProviderUtil.spanSeries(master));
  }

  /**
   * Extend a series' reported end to its last occurrence.
   *
   * The master is the first occurrence, so its own `end` is that occurrence's
   * end. A range test against a recent window therefore excludes the series even
   * though it has occurrences inside it -- the same failure the `singleEvents`
   * change fixes upstream, so the bounds are corrected here too. The start is
   * left alone: the master is already the earliest occurrence.
   */
  private static spanSeries(event: CalendarEvent): CalendarEvent {
    const ends = (event.overrides ?? [])
      .map((override) => override.end?.dateTime ?? override.end?.date)
      .filter((value): value is string => Boolean(value));
    if (!ends.length) return event;
    const latest = ends.reduce((furthest, candidate) =>
      new Date(candidate).getTime() > new Date(furthest).getTime() ? candidate : furthest,
    );
    return { ...event, end: { dateTime: latest, timeZone: 'UTC' } };
  }

  public static async getEvent(accessToken: string, calendarId: string, eventId: string): Promise<CalendarEvent> {
    return GoogleCalendarProviderUtil.fromGoogleEvent(
      await fetchProviderJson<GoogleEvent>(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        accessToken,
      ),
    );
  }

  /**
   * Create or update an event.
   *
   * `ifEtag` is forwarded as a real conditional write. The bridge's own
   * `If-Match` is only checked against a local mirror of the last etag it
   * observed, so without this a change made in the Google UI between the last
   * read and the client's `PUT` was overwritten with no `412` anywhere -- the
   * client's conditional intent was silently dropped, on their real calendar.
   */
  public static async upsertEvent(
    accessToken: string,
    calendarId: string,
    event: CalendarEvent,
    providerEventId?: string,
    ifEtag?: string,
  ): Promise<CalendarEvent> {
    const url = providerEventId
      ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(providerEventId)}`
      : `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (ifEtag) headers['If-Match'] = ifEtag;
    const data = await fetchProviderJson<GoogleEvent>(url, accessToken, {
      method: providerEventId ? 'PUT' : 'POST',
      headers,
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
      attendees: event.attendees
        ?.map((attendee) => ({ email: attendee.email, name: attendee.displayName }))
        .filter((attendee) => attendee.email),
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

  private static toGoogleReminders(alarms?: CalendarEvent['alarms']): {
    useDefault: boolean;
    overrides?: Array<{ method: 'popup'; minutes: number }>;
  } {
    if (!alarms?.length) return { useDefault: false };
    return {
      useDefault: false,
      overrides: alarms.map((alarm) => ({ method: 'popup' as const, minutes: Math.max(0, Math.trunc(alarm.triggerMinutesBeforeStart)) })),
    };
  }
}

interface GoogleCalendar {
  id: string;
  summary?: string;
  description?: string;
  timeZone?: string;
  accessRole?: string;
  etag?: string;
}
interface GoogleEvent {
  id?: string;
  iCalUID?: string;
  etag?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  created?: string;
  updated?: string;
  recurrence?: string[];
  attendees?: Array<{ email: string; displayName?: string }>;
  reminders?: { useDefault: boolean; overrides?: Array<{ method: 'popup'; minutes: number }> };
}

export { GoogleCalendarProviderUtil };
export type { GoogleCalendar, GoogleEvent };
