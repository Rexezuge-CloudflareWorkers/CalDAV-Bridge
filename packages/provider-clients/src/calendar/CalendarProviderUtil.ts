import { NotFoundError } from '@caldav-bridge/backend-errors';
import { PROVIDER_GOOGLE_CALENDAR } from '@caldav-bridge/shared/constants';
import type { ProviderId } from '@caldav-bridge/shared/constants';
import type { CalendarEvent, ProviderCalendar } from '@caldav-bridge/shared/model';
import { GoogleCalendarProviderUtil } from './GoogleCalendarProviderUtil';
import { OutlookCalendarProviderUtil } from './OutlookCalendarProviderUtil';
import type { CalendarEventRange, CalendarProvider } from './CalendarProvider';

/**
 * Provider dispatch.
 *
 * The per-provider behaviour lives behind `ICalendarProvider` and is reached
 * through this table. Callers name a provider; they do not branch on one, so
 * adding a provider is an entry here rather than an `else` arm in six methods.
 * The previous ladders also fell through to Outlook for any unrecognised id, so
 * a typo silently returned the wrong account's data.
 */
const PROVIDERS: Readonly<Record<string, CalendarProvider>> = {
  [PROVIDER_GOOGLE_CALENDAR]: GoogleCalendarProviderUtil,
  'microsoft-outlook-calendar': OutlookCalendarProviderUtil,
} satisfies Record<string, CalendarProvider>;

class CalendarProviderUtil {
  public static providerFor(providerId: ProviderId | string): CalendarProvider {
    const provider = PROVIDERS[providerId];
    // A `404` naming the id is the only safe answer: silently using the default
    // provider would read and write the wrong account's calendar.
    if (!provider) throw new NotFoundError(`No calendar provider is registered for "${providerId}".`);
    return provider;
  }

  public static getProfile(providerId: ProviderId | string, accessToken: string): Promise<{ emailAddress: string }> {
    return CalendarProviderUtil.providerFor(providerId).getProfile(accessToken);
  }

  public static listCalendars(providerId: ProviderId | string, accessToken: string): Promise<ProviderCalendar[]> {
    return CalendarProviderUtil.providerFor(providerId).listCalendars(accessToken);
  }

  public static listEvents(
    providerId: ProviderId | string,
    accessToken: string,
    calendarId: string,
    range: CalendarEventRange = {},
  ): Promise<CalendarEvent[]> {
    return CalendarProviderUtil.providerFor(providerId).listEvents(accessToken, calendarId, range);
  }

  public static getEvent(
    providerId: ProviderId | string,
    accessToken: string,
    calendarId: string,
    eventId: string,
  ): Promise<CalendarEvent> {
    return CalendarProviderUtil.providerFor(providerId).getEvent(accessToken, calendarId, eventId);
  }

  public static upsertEvent(
    providerId: ProviderId | string,
    accessToken: string,
    calendarId: string,
    event: CalendarEvent,
    providerEventId?: string,
    expectedEtag?: string,
  ): Promise<CalendarEvent> {
    return CalendarProviderUtil.providerFor(providerId).upsertEvent(accessToken, calendarId, event, providerEventId, expectedEtag);
  }

  public static deleteEvent(providerId: ProviderId | string, accessToken: string, calendarId: string, eventId: string): Promise<void> {
    return CalendarProviderUtil.providerFor(providerId).deleteEvent(accessToken, calendarId, eventId);
  }

  /**
   * Whether an event falls inside a requested window.
   *
   * Unbounded on either side means unbounded on that side, and an event whose
   * bounds cannot be read is kept rather than dropped: a client asking for a
   * window should not silently lose an event because a provider sent a date
   * this could not parse. A recurring series is kept if any of its overrides
   * falls inside, which is what makes an expanded series survive a bounded
   * query.
   */
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
