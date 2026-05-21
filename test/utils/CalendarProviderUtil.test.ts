import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_GOOGLE_CALENDAR, PROVIDER_MICROSOFT_OUTLOOK_CALENDAR } from '@caldav-bridge/shared/constants';
import { CalendarProviderUtil, HttpError } from '@/utils';

describe('CalendarProviderUtil', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
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

  it('maps Microsoft weekly recurrence to iCalendar RRULE', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        value: [
          {
            id: 'series-master',
            iCalUId: 'series-master@example.test',
            subject: 'Weekly sync',
            start: { dateTime: '2026-05-04T10:00:00.0000000', timeZone: 'UTC' },
            end: { dateTime: '2026-05-04T10:30:00.0000000', timeZone: 'UTC' },
            recurrence: {
              pattern: { type: 'weekly', interval: 2, daysOfWeek: ['monday', 'wednesday'], firstDayOfWeek: 'monday' },
              range: { type: 'numbered', startDate: '2026-05-04', numberOfOccurrences: 5 },
            },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const events = await CalendarProviderUtil.listEvents(PROVIDER_MICROSOFT_OUTLOOK_CALENDAR, 'token', 'calendar-id');

    expect(events[0]?.recurrence).toEqual(['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;WKST=MO;COUNT=5']);
  });

  it('maps Microsoft relative monthly recurrence to iCalendar RRULE', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        value: [
          {
            id: 'series-master',
            iCalUId: 'series-master@example.test',
            subject: 'Monthly review',
            start: { dateTime: '2026-05-14T10:00:00.0000000', timeZone: 'UTC' },
            end: { dateTime: '2026-05-14T10:30:00.0000000', timeZone: 'UTC' },
            recurrence: {
              pattern: { type: 'relativeMonthly', interval: 1, daysOfWeek: ['thursday'], index: 'second' },
              range: { type: 'endDate', startDate: '2026-05-14', endDate: '2026-12-31' },
            },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const events = await CalendarProviderUtil.listEvents(PROVIDER_MICROSOFT_OUTLOOK_CALENDAR, 'token', 'calendar-id');

    expect(events[0]?.recurrence).toEqual(['RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=2TH;UNTIL=20261231T235959Z']);
  });

  it('retries short Microsoft Graph throttles', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Too many requests' } }, 429, { 'Retry-After': '0' }))
      .mockResolvedValueOnce(jsonResponse({ value: [{ id: 'one', subject: 'One', start: { dateTime: '2026-05-01T10:00:00Z' }, end: { dateTime: '2026-05-01T11:00:00Z' } }] }));
    vi.stubGlobal('fetch', fetchMock);

    const events = await CalendarProviderUtil.listEvents(PROVIDER_MICROSOFT_OUTLOOK_CALENDAR, 'token', 'calendar-id');

    expect(events.map((event) => event.id)).toEqual(['one']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps long provider throttles to retryable service errors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ error: { message: 'Application is over its MailboxConcurrency limit.' } }, 429, { 'Retry-After': '10' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(CalendarProviderUtil.listEvents(PROVIDER_MICROSOFT_OUTLOOK_CALENDAR, 'token', 'calendar-id')).rejects.toMatchObject({
      status: 503,
      headers: { 'Retry-After': '10' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps provider missing events as not found errors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ error: { message: 'Gone' } }, 410));
    vi.stubGlobal('fetch', fetchMock);

    const promise = CalendarProviderUtil.getEvent(PROVIDER_MICROSOFT_OUTLOOK_CALENDAR, 'token', 'calendar-id', 'event-id');
    await expect(promise).rejects.toBeInstanceOf(HttpError);
    await expect(promise).rejects.toMatchObject({ status: 404 });
  });
});

function jsonResponse(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
