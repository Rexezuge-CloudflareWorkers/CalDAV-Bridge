import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_GOOGLE_CALENDAR, PROVIDER_MICROSOFT_OUTLOOK_CALENDAR } from '@caldav-bridge/shared/constants';
import { CalendarProviderUtil } from '@/utils';

describe('CalendarProviderUtil', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('follows Google calendar pagination', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'one', summary: 'One' }], nextPageToken: 'next-page' }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'two', summary: 'Two' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const calendars = await CalendarProviderUtil.listCalendars(PROVIDER_GOOGLE_CALENDAR, 'token');

    expect(calendars.map((calendar) => calendar.id)).toEqual(['one', 'two']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(fetchMock.mock.calls[1]?.[0] as string).searchParams.get('pageToken')).toBe('next-page');
  });

  it('follows Microsoft event pagination', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ value: [{ id: 'one', subject: 'One', start: { dateTime: '2026-05-01T10:00:00Z' }, end: { dateTime: '2026-05-01T11:00:00Z' } }], '@odata.nextLink': 'https://graph.microsoft.com/next' }))
      .mockResolvedValueOnce(jsonResponse({ value: [{ id: 'two', subject: 'Two', start: { dateTime: '2026-05-02T10:00:00Z' }, end: { dateTime: '2026-05-02T11:00:00Z' } }] }));
    vi.stubGlobal('fetch', fetchMock);

    const events = await CalendarProviderUtil.listEvents(PROVIDER_MICROSOFT_OUTLOOK_CALENDAR, 'token', 'calendar-id');

    expect(events.map((event) => event.id)).toEqual(['one', 'two']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://graph.microsoft.com/next');
  });

  it('uses Microsoft calendarView for time-range event queries', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ value: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await CalendarProviderUtil.listEvents(PROVIDER_MICROSOFT_OUTLOOK_CALENDAR, 'token', 'calendar-id', {
      start: '2026-05-01T00:00:00Z',
      end: '2026-06-01T00:00:00Z',
    });

    const url = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe('/v1.0/me/calendars/calendar-id/calendarView');
    expect(url.searchParams.get('startDateTime')).toBe('2026-05-01T00:00:00Z');
    expect(url.searchParams.get('endDateTime')).toBe('2026-06-01T00:00:00Z');
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
