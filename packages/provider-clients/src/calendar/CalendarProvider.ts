import type { CalendarEvent, ProviderCalendar } from '@caldav-bridge/shared/model';

/** The window an event list is requested for. Either bound may be absent. */
interface CalendarEventRange {
  start?: string | undefined;
  end?: string | undefined;
}

/**
 * The operations a calendar provider must support.
 *
 * Provider clients in this package are classes with static methods, so the
 * contract is a type describing that shape rather than an `interface` used with
 * `implements` -- `implements` checks *instance* members, and would reject a
 * class of statics outright. Conformance is asserted where the providers are
 * registered, which is the only place a provider can actually be reached.
 */
type CalendarProvider = {
  getProfile(accessToken: string): Promise<{ emailAddress: string }>;
  listCalendars(accessToken: string): Promise<ProviderCalendar[]>;
  listEvents(accessToken: string, calendarId: string, range?: CalendarEventRange): Promise<CalendarEvent[]>;
  getEvent(accessToken: string, calendarId: string, eventId: string): Promise<CalendarEvent>;
  /**
   * Create or replace an event.
   *
   * `expectedEtag` makes the write conditional, so an edit made in the
   * provider's own UI since this bridge last read is reported rather than
   * silently overwritten.
   */
  upsertEvent(
    accessToken: string,
    calendarId: string,
    event: CalendarEvent,
    providerEventId?: string,
    expectedEtag?: string,
  ): Promise<CalendarEvent>;
  deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void>;
};

export type { CalendarEventRange, CalendarProvider };
