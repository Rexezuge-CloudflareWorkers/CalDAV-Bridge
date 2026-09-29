import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '@caldav-bridge/backend-errors';
import type { CalendarEvent } from '@caldav-bridge/shared/model';
import { CalendarProviderUtil } from '@caldav-bridge/provider-clients/calendar';
import { GoogleCalendarProviderUtil } from '@caldav-bridge/provider-clients/calendar/GoogleCalendarProviderUtil';
import { OutlookCalendarProviderUtil } from '@caldav-bridge/provider-clients/calendar/OutlookCalendarProviderUtil';

const PROVIDER_GOOGLE = 'google-calendar';
const PROVIDER_OUTLOOK = 'microsoft-outlook-calendar';

describe('CalendarProviderUtil registry', () => {
  it('resolves each registered provider to its implementation', () => {
    expect(CalendarProviderUtil.providerFor(PROVIDER_GOOGLE)).toBe(GoogleCalendarProviderUtil);
    expect(CalendarProviderUtil.providerFor(PROVIDER_OUTLOOK)).toBe(OutlookCalendarProviderUtil);
  });

  /**
   * The dispatch used to be an `if (providerId === GOOGLE) … else …` ladder in
   * every method, so any unrecognised id -- a typo, a provider that has since
   * been removed, a value that reached the database from outside -- silently
   * fell through to Outlook. That is the wrong account's calendar.
   */
  it('refuses an unregistered provider instead of falling back to one', () => {
    for (const providerId of ['google', 'outlook', '', 'GOOGLE-CALENDAR', 'apple-calendar']) {
      expect(() => CalendarProviderUtil.providerFor(providerId)).toThrow(NotFoundError);
    }
  });

  it('names the offending id in the error', () => {
    expect(() => CalendarProviderUtil.providerFor('apple-calendar')).toThrow(/apple-calendar/);
  });

  // The entry points are not `async`, so an unknown id throws synchronously --
  // there is no promise to await. `expect(...).rejects` would miss it entirely,
  // which is how a synchronous throw here could reach production unhandled.
  it('throws synchronously through every entry point', () => {
    expect(() => CalendarProviderUtil.listCalendars('apple-calendar', 'token')).toThrow(NotFoundError);
    expect(() => CalendarProviderUtil.listEvents('apple-calendar', 'token', 'cal-1')).toThrow(NotFoundError);
    expect(() => CalendarProviderUtil.getEvent('apple-calendar', 'token', 'cal-1', 'event-1')).toThrow(NotFoundError);
    expect(() => CalendarProviderUtil.getProfile('apple-calendar', 'token')).toThrow(NotFoundError);
    expect(() => CalendarProviderUtil.upsertEvent('apple-calendar', 'token', 'cal-1', event())).toThrow(NotFoundError);
    expect(() => CalendarProviderUtil.deleteEvent('apple-calendar', 'token', 'cal-1', 'event-1')).toThrow(NotFoundError);
  });

  it('rejects before any provider request is made', () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(() => CalendarProviderUtil.listCalendars('apple-calendar', 'token')).toThrow(NotFoundError);
      // An unknown provider must not reach the network at all.
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('CalendarProviderUtil range overlap', () => {
  it('keeps every event before a window that has no start', () => {
    // A window bounded only on one side reaches arbitrarily far on the other,
    // so an event on the open side of the bound is always inside it.
    expect(
      CalendarProviderUtil.eventOverlapsRange(event({ start: '2026-01-01T00:00:00Z', end: '2026-01-01T11:00:00Z' }), {
        end: '2026-06-01T00:00:00Z',
      }),
    ).toBe(true);
  });

  it('keeps an event after an open-ended window', () => {
    expect(
      CalendarProviderUtil.eventOverlapsRange(event({ start: '2026-07-01T00:00:00Z', end: '2026-07-01T11:00:00Z' }), {
        start: '2026-06-01T00:00:00Z',
      }),
    ).toBe(true);
    expect(
      CalendarProviderUtil.eventOverlapsRange(event({ start: '2026-01-01T00:00:00Z', end: '2026-01-01T11:00:00Z' }), {
        start: '2026-06-01T00:00:00Z',
      }),
    ).toBe(false);
  });

  it('excludes an event entirely outside a bounded window', () => {
    expect(
      CalendarProviderUtil.eventOverlapsRange(event({ start: '2026-01-01T00:00:00Z', end: '2026-01-01T11:00:00Z' }), {
        start: '2026-06-01T00:00:00Z',
        end: '2026-07-01T00:00:00Z',
      }),
    ).toBe(false);
  });

  it('keeps a series with any occurrence inside the window', () => {
    // The recurring-series failure this whole arrangement exists to prevent: a
    // master whose bounds are its *first* occurrence, filtered out of a recent
    // window even though it recurs into it.
    const series: CalendarEvent = {
      ...event({ start: '2026-01-05T10:00:00Z', end: '2026-01-05T11:00:00Z' }),
      overrides: [event({ start: '2026-05-20T10:00:00Z', end: '2026-05-20T11:00:00Z' })],
    };

    expect(CalendarProviderUtil.eventOverlapsRange(series, { start: '2026-05-01T00:00:00Z', end: '2026-06-01T00:00:00Z' })).toBe(true);
  });

  it('keeps an event whose bounds cannot be read, rather than dropping it', () => {
    // Losing an event to an unparseable provider date is worse than returning
    // one the client can re-check.
    expect(CalendarProviderUtil.eventOverlapsRange(event({ start: 'not-a-date' }), { start: '2026-06-01T00:00:00Z' })).toBe(true);
  });
});

function event(overrides: { start: string; end?: string } = { start: '2026-01-01T00:00:00Z' }): CalendarEvent {
  return {
    uid: 'event@example.com',
    start: { dateTime: overrides.start, timeZone: 'UTC' },
    end: { dateTime: overrides.end ?? '2026-01-01T11:00:00Z', timeZone: 'UTC' },
  };
}
