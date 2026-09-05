import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, NotFoundError } from '@caldav-bridge/backend-errors';
import { PROVIDER_GOOGLE_CALENDAR } from '@caldav-bridge/shared/constants';
import { CalendarService } from '@caldav-bridge/backend-services/calendar';

function testService(): CalendarService {
  return new CalendarService({
    DB: {},
    AES_ENCRYPTION_KEY_SECRET: { get: async () => 'master-key' },
    OAUTH2_TOKEN_CACHE: {},
  } as never);
}

function application(): Record<string, unknown> {
  return { applicationId: 'app-1', providerId: PROVIDER_GOOGLE_CALENDAR };
}

function mappingDAO(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    getByHref: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockImplementation(async (_app: string, _cal: string, href: string, providerEventId: string, uid: string, etag?: string) => ({
      href,
      providerEventId,
      uid,
      etag,
      syncVersion: 1,
      deletedAt: null,
    })),
    markMissingProviderEventsDeleted: vi.fn().mockResolvedValue([]),
    listByCalendar: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('CalendarService', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches provider objects and records mappings', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({ id: 'provider-1', iCalUID: 'uid-1', start: { dateTime: '2026-05-01T10:00:00Z' }, end: { dateTime: '2026-05-01T11:00:00Z' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const dao = mappingDAO();

    const event = await testService().getDavObject(application() as never, 'token', dao as never, 'cal-1', 'event.ics');

    expect(event.uid).toBe('uid-1');
    expect(dao.upsert).toHaveBeenCalledWith('app-1', 'cal-1', 'event.ics', 'provider-1', 'uid-1', undefined);
  });

  it('rejects deleted mappings as not found', async () => {
    const dao = mappingDAO({ getByHref: vi.fn().mockResolvedValue({ href: 'gone.ics', deletedAt: 123 }) });

    await expect(testService().getDavObject(application() as never, 'token', dao as never, 'cal-1', 'gone.ics')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('requires writable calendars', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'cal-1', summary: 'Main', accessRole: 'owner' }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'cal-1', summary: 'Main', accessRole: 'reader' }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'cal-1', summary: 'Main', accessRole: 'owner' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const service = testService();

    await expect(service.requireWritableCalendar(application() as never, 'token', 'cal-1')).resolves.toBeUndefined();
    await expect(service.requireWritableCalendar(application() as never, 'token', 'cal-1')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.requireCalendar(application() as never, 'token', 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('syncs provider snapshots and reports mapping changes', async () => {
    const dao = mappingDAO({
      listByCalendar: vi.fn().mockResolvedValue([{ href: 'deleted.ics', status: 404, deletedAt: 5, syncVersion: 2, providerEventId: 'gone' }]),
    });
    const service = testService();
    const events = [
      { id: 'provider-1', uid: 'uid-1', start: { dateTime: '2026-05-01T10:00:00Z' }, end: { dateTime: '2026-05-01T11:00:00Z' } },
    ];

    const synced = await service.syncProviderSnapshot(dao as never, 'app-1', 'cal-1', events as never);

    expect(synced.live).toHaveLength(1);
    expect(synced.deleted).toEqual([{ href: 'deleted.ics', status: 404, syncVersion: 2 }]);
    expect(dao.markMissingProviderEventsDeleted).toHaveBeenCalledWith('app-1', 'cal-1', new Set(['provider-1']));

    const results = service.mappingsToReportResults(
      [
        { href: 'live.ics', providerEventId: 'provider-1', deletedAt: null, syncVersion: 1 },
        { href: 'gone.ics', providerEventId: 'gone', deletedAt: 5, syncVersion: 2 },
        { href: 'unknown.ics', providerEventId: 'unknown', deletedAt: null, syncVersion: 3 },
      ] as never,
      new Map([['provider-1', events[0] as never]]),
    );

    expect(results).toEqual([
      { href: 'live.ics', event: events[0], syncVersion: 1 },
      { href: 'gone.ics', status: 404, syncVersion: 2 },
      { href: 'unknown.ics', status: 404, syncVersion: 3 },
    ]);
  });
});
