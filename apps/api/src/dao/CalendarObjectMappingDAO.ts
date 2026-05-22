import type { CalendarObjectMappingInternal } from '@caldav-bridge/shared/model';
import { TimestampUtil, UUIDUtil } from '@caldav-bridge/shared/utils';

interface CalendarObjectMapping {
  objectId: string;
  applicationId: string;
  calendarId: string;
  href: string;
  providerEventId: string;
  uid: string;
  etag?: string | null | undefined;
}

class CalendarObjectMappingDAO {
  constructor(private readonly database: D1Database) {}

  public async getByHref(applicationId: string, calendarId: string, href: string): Promise<CalendarObjectMapping | undefined> {
    const row = await this.database
      .prepare(
        `
          SELECT object_id, application_id, calendar_id, href, provider_event_id, uid, etag, created_at, updated_at
          FROM calendar_object_mappings
          WHERE application_id = ? AND calendar_id = ? AND href = ?
          LIMIT 1
        `,
      )
      .bind(applicationId, calendarId, href)
      .first<CalendarObjectMappingInternal>();
    return row ? this.toMapping(row) : undefined;
  }

  public async getByProviderEventId(applicationId: string, calendarId: string, providerEventId: string): Promise<CalendarObjectMapping | undefined> {
    const row = await this.database
      .prepare(
        `
          SELECT object_id, application_id, calendar_id, href, provider_event_id, uid, etag, created_at, updated_at
          FROM calendar_object_mappings
          WHERE application_id = ? AND calendar_id = ? AND provider_event_id = ?
          LIMIT 1
        `,
      )
      .bind(applicationId, calendarId, providerEventId)
      .first<CalendarObjectMappingInternal>();
    return row ? this.toMapping(row) : undefined;
  }

  public async upsert(applicationId: string, calendarId: string, href: string, providerEventId: string, uid: string, etag?: string): Promise<CalendarObjectMapping> {
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const existingProviderMapping = await this.getByProviderEventId(applicationId, calendarId, providerEventId);
    if (existingProviderMapping && existingProviderMapping.href !== href) {
      await this.database
        .prepare(
          `
            UPDATE calendar_object_mappings
            SET uid = ?, etag = ?, updated_at = ?
            WHERE application_id = ? AND calendar_id = ? AND provider_event_id = ?
          `,
        )
        .bind(uid, etag || null, now, applicationId, calendarId, providerEventId)
        .run();
      return { ...existingProviderMapping, uid, etag: etag || null };
    }

    await this.database
      .prepare(
        `
          INSERT INTO calendar_object_mappings
            (object_id, application_id, calendar_id, href, provider_event_id, uid, etag, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(application_id, calendar_id, href) DO UPDATE SET
            provider_event_id = excluded.provider_event_id,
            uid = excluded.uid,
            etag = excluded.etag,
            updated_at = excluded.updated_at
        `,
      )
      .bind(UUIDUtil.getRandomUUID(), applicationId, calendarId, href, providerEventId, uid, etag || null, now, now)
      .run();
    const mapping = await this.getByHref(applicationId, calendarId, href);
    if (!mapping) throw new Error('Failed to read calendar object mapping after upsert.');
    return mapping;
  }

  public async deleteByHref(applicationId: string, calendarId: string, href: string): Promise<void> {
    await this.database
      .prepare('DELETE FROM calendar_object_mappings WHERE application_id = ? AND calendar_id = ? AND href = ?')
      .bind(applicationId, calendarId, href)
      .run();
  }

  private toMapping(row: CalendarObjectMappingInternal): CalendarObjectMapping {
    return {
      objectId: row.object_id,
      applicationId: row.application_id,
      calendarId: row.calendar_id,
      href: row.href,
      providerEventId: row.provider_event_id,
      uid: row.uid,
      etag: row.etag,
    };
  }
}

export { CalendarObjectMappingDAO };
export type { CalendarObjectMapping };
