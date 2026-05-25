import { describe, expect, it } from 'vitest';
import { CalendarObjectMappingDAO } from '@/dao';

describe('CalendarObjectMappingDAO', () => {
  it('preserves a local CalDAV href when provider sync sees the same event id', async () => {
    const database = new FakeCalendarObjectMappingDatabase();
    const dao = new CalendarObjectMappingDAO(database as unknown as D1Database);

    const localMapping = await dao.upsert('app-1', 'cal-1', 'local-created.ics', 'provider-event-1', 'uid-1', 'etag-1');
    const syncedMapping = await dao.upsert('app-1', 'cal-1', 'provider-event-1.ics', 'provider-event-1', 'uid-1', 'etag-2');

    expect(localMapping.href).toBe('local-created.ics');
    expect(syncedMapping.href).toBe('local-created.ics');
    expect(syncedMapping.etag).toBe('etag-2');
    expect(database.rows).toHaveLength(1);
  });

  it('marks missing provider events as deleted and restores them on upsert', async () => {
    const database = new FakeCalendarObjectMappingDatabase();
    const dao = new CalendarObjectMappingDAO(database as unknown as D1Database);
    await dao.upsert('app-1', 'cal-1', 'one.ics', 'provider-one', 'uid-1', 'etag-1');
    await dao.upsert('app-1', 'cal-1', 'two.ics', 'provider-two', 'uid-2', 'etag-2');

    const deleted = await dao.markMissingProviderEventsDeleted('app-1', 'cal-1', new Set(['provider-two']));

    expect(deleted.map((mapping) => mapping.href)).toEqual(['one.ics']);
    expect((await dao.getByHref('app-1', 'cal-1', 'one.ics'))?.deletedAt).toBeTruthy();
    expect(await dao.listChangedSince('app-1', 'cal-1', 2)).toHaveLength(1);

    const restored = await dao.upsert('app-1', 'cal-1', 'one.ics', 'provider-one', 'uid-1', 'etag-3');

    expect(restored.deletedAt).toBeNull();
    expect(restored.etag).toBe('etag-3');
    expect(await dao.listByCalendar('app-1', 'cal-1')).toHaveLength(2);
  });

  it('marks local deletes as sync tombstones', async () => {
    const database = new FakeCalendarObjectMappingDatabase();
    const dao = new CalendarObjectMappingDAO(database as unknown as D1Database);
    await dao.upsert('app-1', 'cal-1', 'one.ics', 'provider-one', 'uid-1', 'etag-1');

    const deleted = await dao.markDeletedByHref('app-1', 'cal-1', 'one.ics');

    expect(deleted?.deletedAt).toBeTruthy();
    expect(await dao.listByCalendar('app-1', 'cal-1')).toEqual([]);
    expect(await dao.listChangedSince('app-1', 'cal-1', 1)).toHaveLength(1);
  });
});

interface MappingRow {
  object_id: string;
  application_id: string;
  calendar_id: string;
  href: string;
  provider_event_id: string;
  uid: string;
  etag: string | null;
  deleted_at: number | null;
  sync_version: number;
  created_at: number;
  updated_at: number;
}

class FakeCalendarObjectMappingDatabase {
  public readonly rows: MappingRow[] = [];

  public prepare(sql: string): FakePreparedStatement {
    return new FakePreparedStatement(this.rows, sql);
  }
}

class FakePreparedStatement {
  private values: unknown[] = [];

  constructor(private readonly rows: MappingRow[], private readonly sql: string) {}

  public bind(...values: unknown[]): FakePreparedStatement {
    this.values = values;
    return this;
  }

  public async first<T>(): Promise<T | null> {
    if (/COALESCE\(MAX\(sync_version\), 0\)/i.test(this.sql)) {
      const [applicationId, calendarId] = this.values;
      const max = this.rows
        .filter((row) => row.application_id === applicationId && row.calendar_id === calendarId)
        .reduce((value, row) => Math.max(value, row.sync_version), 0);
      return { sync_version: max } as T;
    }
    if (this.sql.includes('WHERE application_id = ? AND calendar_id = ? AND href = ?')) {
      const [applicationId, calendarId, href] = this.values;
      return (this.rows.find((row) => row.application_id === applicationId && row.calendar_id === calendarId && row.href === href) as T | undefined) || null;
    }
    if (this.sql.includes('WHERE application_id = ? AND calendar_id = ? AND provider_event_id = ?')) {
      const [applicationId, calendarId, providerEventId] = this.values;
      return (
        (this.rows.find((row) => row.application_id === applicationId && row.calendar_id === calendarId && row.provider_event_id === providerEventId) as T | undefined) ||
        null
      );
    }
    return null;
  }

  public async all<T>(): Promise<D1Result<T>> {
    const [applicationId, calendarId, syncVersion] = this.values;
    let results = this.rows.filter((row) => row.application_id === applicationId && row.calendar_id === calendarId);
    if (this.sql.includes('deleted_at IS NULL')) results = results.filter((row) => row.deleted_at === null);
    if (this.sql.includes('sync_version > ?')) results = results.filter((row) => row.sync_version > (syncVersion as number));
    return { ...fakeD1Result(), results: results as T[] };
  }

  public async run(): Promise<D1Result> {
    if (/SET deleted_at = \?/i.test(this.sql)) {
      const [deletedAt, syncVersion, updatedAt, applicationId, calendarId, href] = this.values;
      const row = this.rows.find((item) => item.application_id === applicationId && item.calendar_id === calendarId && item.href === href);
      if (row && row.deleted_at === null) {
        row.deleted_at = deletedAt as number;
        row.sync_version = syncVersion as number;
        row.updated_at = updatedAt as number;
      }
      return fakeD1Result();
    }

    if (/SET uid = \?, etag = \?, deleted_at = null/i.test(this.sql)) {
      const [uid, etag, syncVersion, updatedAt, applicationId, calendarId, providerEventId] = this.values;
      const row = this.rows.find((item) => item.application_id === applicationId && item.calendar_id === calendarId && item.provider_event_id === providerEventId);
      if (row) {
        row.uid = uid as string;
        row.etag = etag as string | null;
        row.deleted_at = null;
        row.sync_version = syncVersion as number;
        row.updated_at = updatedAt as number;
      }
      return fakeD1Result();
    }

    if (/SET provider_event_id = \?, uid = \?, etag = \?, deleted_at = null/i.test(this.sql)) {
      const [providerEventId, uid, etag, syncVersion, updatedAt, applicationId, calendarId, href] = this.values;
      const row = this.rows.find((item) => item.application_id === applicationId && item.calendar_id === calendarId && item.href === href);
      if (row) {
        row.provider_event_id = providerEventId as string;
        row.uid = uid as string;
        row.etag = etag as string | null;
        row.deleted_at = null;
        row.sync_version = syncVersion as number;
        row.updated_at = updatedAt as number;
      }
      return fakeD1Result();
    }

    if (/UPDATE calendar_object_mappings/i.test(this.sql)) {
      const [uid, etag, updatedAt, applicationId, calendarId, providerEventId] = this.values;
      const row = this.rows.find((item) => item.application_id === applicationId && item.calendar_id === calendarId && item.provider_event_id === providerEventId);
      if (row) {
        row.uid = uid as string;
        row.etag = etag as string | null;
        row.updated_at = updatedAt as number;
      }
      return fakeD1Result();
    }

    if (/INSERT INTO calendar_object_mappings/i.test(this.sql)) {
      const [objectId, applicationId, calendarId, href, providerEventId, uid, etag, syncVersion, createdAt, updatedAt] = this.values;
      const existingByProvider = this.rows.find(
        (row) => row.application_id === applicationId && row.calendar_id === calendarId && row.provider_event_id === providerEventId,
      );
      if (existingByProvider && existingByProvider.href !== href) throw new Error('UNIQUE constraint failed: calendar_object_mappings.provider_event_id');

      const existingByHref = this.rows.find((row) => row.application_id === applicationId && row.calendar_id === calendarId && row.href === href);
      if (existingByHref) {
        existingByHref.provider_event_id = providerEventId as string;
        existingByHref.uid = uid as string;
        existingByHref.etag = etag as string | null;
        existingByHref.deleted_at = null;
        existingByHref.sync_version = syncVersion as number;
        existingByHref.updated_at = updatedAt as number;
      } else {
        this.rows.push({
          object_id: objectId as string,
          application_id: applicationId as string,
          calendar_id: calendarId as string,
          href: href as string,
          provider_event_id: providerEventId as string,
          uid: uid as string,
          etag: etag as string | null,
          deleted_at: null,
          sync_version: syncVersion as number,
          created_at: createdAt as number,
          updated_at: updatedAt as number,
        });
      }
    }
    return fakeD1Result();
  }
}

function fakeD1Result(): D1Result {
  return { success: true, meta: {} } as D1Result;
}
