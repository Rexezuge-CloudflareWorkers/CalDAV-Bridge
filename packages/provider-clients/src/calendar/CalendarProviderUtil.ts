import { PROVIDER_GOOGLE_CALENDAR } from '@caldav-bridge/shared/constants';
import type { ProviderId } from '@caldav-bridge/shared/constants';
import type { CalendarEvent, ProviderCalendar } from '@caldav-bridge/shared/model';
import { GoogleCalendarProviderUtil } from './GoogleCalendarProviderUtil';
import type { CalendarEventRange } from './GoogleCalendarProviderUtil';
import { OutlookCalendarProviderUtil } from './OutlookCalendarProviderUtil';

class CalendarProviderUtil {
  public static async getProfile(providerId: ProviderId | string, accessToken: string): Promise<{ emailAddress: string }> {
    if (providerId === PROVIDER_GOOGLE_CALENDAR) return GoogleCalendarProviderUtil.getProfile(accessToken);
    return OutlookCalendarProviderUtil.getProfile(accessToken);
  }

  public static async listCalendars(providerId: ProviderId | string, accessToken: string): Promise<ProviderCalendar[]> {
    if (providerId === PROVIDER_GOOGLE_CALENDAR) return GoogleCalendarProviderUtil.listCalendars(accessToken);
    return OutlookCalendarProviderUtil.listCalendars(accessToken);
  }

  public static async listEvents(providerId: ProviderId | string, accessToken: string, calendarId: string, range: CalendarEventRange = {}): Promise<CalendarEvent[]> {
    if (providerId === PROVIDER_GOOGLE_CALENDAR) {
      const events = await GoogleCalendarProviderUtil.listEvents(accessToken, calendarId, range);
      return events.filter((event) => CalendarProviderUtil.eventOverlapsRange(event, range));
    }
    const graphEvents = await OutlookCalendarProviderUtil.listRawEvents(accessToken, calendarId);
    const mappedEvents = graphEvents.map((event) => OutlookCalendarProviderUtil.fromGraphEvent(event));
    const recurringEventIdsInRange = range.start && range.end
      ? await OutlookCalendarProviderUtil.listRecurrenceOverrides(accessToken, calendarId, graphEvents, mappedEvents, { start: range.start, end: range.end })
      : undefined;
    return mappedEvents.filter((event) => recurringEventIdsInRange?.has(event.id || '') || CalendarProviderUtil.eventOverlapsRange(event, range));
  }

  public static async getEvent(providerId: ProviderId | string, accessToken: string, calendarId: string, eventId: string): Promise<CalendarEvent> {
    if (providerId === PROVIDER_GOOGLE_CALENDAR) return GoogleCalendarProviderUtil.getEvent(accessToken, calendarId, eventId);
    return OutlookCalendarProviderUtil.getEvent(accessToken, calendarId, eventId);
  }

  public static async upsertEvent(providerId: ProviderId | string, accessToken: string, calendarId: string, event: CalendarEvent, providerEventId?: string): Promise<CalendarEvent> {
    if (providerId === PROVIDER_GOOGLE_CALENDAR) return GoogleCalendarProviderUtil.upsertEvent(accessToken, calendarId, event, providerEventId);
    return OutlookCalendarProviderUtil.upsertEvent(accessToken, calendarId, event, providerEventId);
  }

  public static async deleteEvent(providerId: ProviderId | string, accessToken: string, calendarId: string, eventId: string): Promise<void> {
    if (providerId === PROVIDER_GOOGLE_CALENDAR) return GoogleCalendarProviderUtil.deleteEvent(accessToken, calendarId, eventId);
    return OutlookCalendarProviderUtil.deleteEvent(accessToken, calendarId, eventId);
  }

  public static eventOverlapsRange(event: CalendarEvent, range: CalendarEventRange): boolean {
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
}

export { CalendarProviderUtil };
export type { CalendarEventRange };
