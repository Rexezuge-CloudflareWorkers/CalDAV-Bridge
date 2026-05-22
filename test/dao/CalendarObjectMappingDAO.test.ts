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
});

interface MappingRow {
  object_id: string;
  application_id: string;
  calendar_id: string;
  href: string;
  provider_event_id: string;
  uid: string;
  etag: string | null;
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

  public async run(): Promise<D1Result> {
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
      const [objectId, applicationId, calendarId, href, providerEventId, uid, etag, createdAt, updatedAt] = this.values;
      const existingByProvider = this.rows.find(
        (row) => row.application_id === applicationId && row.calendar_id === calendarId && row.provider_event_id === providerEventId,
      );
      if (existingByProvider && existingByProvider.href !== href) throw new Error('UNIQUE constraint failed: calendar_object_mappings.provider_event_id');

      const existingByHref = this.rows.find((row) => row.application_id === applicationId && row.calendar_id === calendarId && row.href === href);
      if (existingByHref) {
        existingByHref.provider_event_id = providerEventId as string;
        existingByHref.uid = uid as string;
        existingByHref.etag = etag as string | null;
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
