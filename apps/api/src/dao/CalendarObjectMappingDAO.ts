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
  deletedAt?: number | null | undefined;
  syncVersion: number;
}

class CalendarObjectMappingDAO {
  constructor(private readonly database: D1Database) {}

  public async getByHref(applicationId: string, calendarId: string, href: string): Promise<CalendarObjectMapping | undefined> {
    const row = await this.database
      .prepare(
        `
          SELECT object_id, application_id, calendar_id, href, provider_event_id, uid, etag, deleted_at, sync_version, created_at, updated_at
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
          SELECT object_id, application_id, calendar_id, href, provider_event_id, uid, etag, deleted_at, sync_version, created_at, updated_at
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
      if (this.mappingMatches(existingProviderMapping, providerEventId, uid, etag)) return existingProviderMapping;
      return this.updateByProviderEventId(applicationId, calendarId, providerEventId, uid, etag, now);
    }

    const existingHrefMapping = await this.getByHref(applicationId, calendarId, href);
    if (existingHrefMapping) {
      if (this.mappingMatches(existingHrefMapping, providerEventId, uid, etag)) return existingHrefMapping;
      return this.updateByHref(applicationId, calendarId, href, providerEventId, uid, etag, now);
    }

    const syncVersion = await this.nextSyncVersion(applicationId, calendarId);

    await this.database
      .prepare(
        `
          INSERT INTO calendar_object_mappings
            (object_id, application_id, calendar_id, href, provider_event_id, uid, etag, deleted_at, sync_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?)
        `,
      )
      .bind(UUIDUtil.getRandomUUID(), applicationId, calendarId, href, providerEventId, uid, etag || null, syncVersion, now, now)
      .run();
    const mapping = await this.getByHref(applicationId, calendarId, href);
    if (!mapping) throw new Error('Failed to read calendar object mapping after upsert.');
    return mapping;
  }

  public async listByCalendar(applicationId: string, calendarId: string, includeDeleted = false): Promise<CalendarObjectMapping[]> {
    const rows = await this.database
      .prepare(
        `
          SELECT object_id, application_id, calendar_id, href, provider_event_id, uid, etag, deleted_at, sync_version, created_at, updated_at
          FROM calendar_object_mappings
          WHERE application_id = ? AND calendar_id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}
          ORDER BY href
        `,
      )
      .bind(applicationId, calendarId)
      .all<CalendarObjectMappingInternal>();
    return (rows.results || []).map((row) => this.toMapping(row));
  }

  public async listChangedSince(applicationId: string, calendarId: string, syncVersion: number): Promise<CalendarObjectMapping[]> {
    const rows = await this.database
      .prepare(
        `
          SELECT object_id, application_id, calendar_id, href, provider_event_id, uid, etag, deleted_at, sync_version, created_at, updated_at
          FROM calendar_object_mappings
          WHERE application_id = ? AND calendar_id = ? AND sync_version > ?
          ORDER BY sync_version, href
        `,
      )
      .bind(applicationId, calendarId, syncVersion)
      .all<CalendarObjectMappingInternal>();
    return (rows.results || []).map((row) => this.toMapping(row));
  }

  public async markMissingProviderEventsDeleted(applicationId: string, calendarId: string, providerEventIds: Set<string>): Promise<CalendarObjectMapping[]> {
    const liveMappings = await this.listByCalendar(applicationId, calendarId);
    const missingMappings = liveMappings.filter((mapping) => !providerEventIds.has(mapping.providerEventId));
    if (!missingMappings.length) return [];

    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const syncVersion = await this.nextSyncVersion(applicationId, calendarId);
    await Promise.all(
      missingMappings.map((mapping) =>
        this.database
          .prepare(
            `
              UPDATE calendar_object_mappings
              SET deleted_at = ?, sync_version = ?, updated_at = ?
              WHERE application_id = ? AND calendar_id = ? AND href = ? AND deleted_at IS NULL
            `,
          )
          .bind(now, syncVersion, now, applicationId, calendarId, mapping.href)
          .run(),
      ),
    );
    return missingMappings.map((mapping) => ({ ...mapping, deletedAt: now, syncVersion }));
  }

  public async getMaxSyncVersion(applicationId: string, calendarId: string): Promise<number> {
    const row = await this.database
      .prepare('SELECT COALESCE(MAX(sync_version), 0) AS sync_version FROM calendar_object_mappings WHERE application_id = ? AND calendar_id = ?')
      .bind(applicationId, calendarId)
      .first<{ sync_version?: number | null }>();
    return row?.sync_version || 0;
  }

  public async deleteByHref(applicationId: string, calendarId: string, href: string): Promise<void> {
    await this.database
      .prepare('DELETE FROM calendar_object_mappings WHERE application_id = ? AND calendar_id = ? AND href = ?')
      .bind(applicationId, calendarId, href)
      .run();
  }

  public async markDeletedByHref(applicationId: string, calendarId: string, href: string): Promise<CalendarObjectMapping | undefined> {
    const mapping = await this.getByHref(applicationId, calendarId, href);
    if (!mapping) return undefined;
    if (mapping.deletedAt) return mapping;
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const syncVersion = await this.nextSyncVersion(applicationId, calendarId);
    await this.database
      .prepare(
        `
          UPDATE calendar_object_mappings
          SET deleted_at = ?, sync_version = ?, updated_at = ?
          WHERE application_id = ? AND calendar_id = ? AND href = ? AND deleted_at IS NULL
        `,
      )
      .bind(now, syncVersion, now, applicationId, calendarId, href)
      .run();
    return { ...mapping, deletedAt: now, syncVersion };
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
      deletedAt: row.deleted_at,
      syncVersion: row.sync_version || 0,
    };
  }

  private mappingMatches(mapping: CalendarObjectMapping, providerEventId: string, uid: string, etag?: string): boolean {
    return mapping.providerEventId === providerEventId && mapping.uid === uid && (mapping.etag || null) === (etag || null) && !mapping.deletedAt && mapping.syncVersion > 0;
  }

  private async updateByProviderEventId(applicationId: string, calendarId: string, providerEventId: string, uid: string, etag: string | undefined, now: number): Promise<CalendarObjectMapping> {
    const syncVersion = await this.nextSyncVersion(applicationId, calendarId);
    await this.database
      .prepare(
        `
          UPDATE calendar_object_mappings
          SET uid = ?, etag = ?, deleted_at = null, sync_version = ?, updated_at = ?
          WHERE application_id = ? AND calendar_id = ? AND provider_event_id = ?
        `,
      )
      .bind(uid, etag || null, syncVersion, now, applicationId, calendarId, providerEventId)
      .run();
    const mapping = await this.getByProviderEventId(applicationId, calendarId, providerEventId);
    if (!mapping) throw new Error('Failed to read calendar object mapping after update.');
    return mapping;
  }

  private async updateByHref(applicationId: string, calendarId: string, href: string, providerEventId: string, uid: string, etag: string | undefined, now: number): Promise<CalendarObjectMapping> {
    const syncVersion = await this.nextSyncVersion(applicationId, calendarId);
    await this.database
      .prepare(
        `
          UPDATE calendar_object_mappings
          SET provider_event_id = ?, uid = ?, etag = ?, deleted_at = null, sync_version = ?, updated_at = ?
          WHERE application_id = ? AND calendar_id = ? AND href = ?
        `,
      )
      .bind(providerEventId, uid, etag || null, syncVersion, now, applicationId, calendarId, href)
      .run();
    const mapping = await this.getByHref(applicationId, calendarId, href);
    if (!mapping) throw new Error('Failed to read calendar object mapping after update.');
    return mapping;
  }

  private async nextSyncVersion(applicationId: string, calendarId: string): Promise<number> {
    return (await this.getMaxSyncVersion(applicationId, calendarId)) + 1;
  }
}

export { CalendarObjectMappingDAO };
export type { CalendarObjectMapping };
