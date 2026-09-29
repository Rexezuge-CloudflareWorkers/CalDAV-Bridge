import { InternalServerError } from '@caldav-bridge/backend-errors';
import type { CalendarObjectMappingInternal } from '@caldav-bridge/shared/model';
import { TimestampUtil, UUIDUtil } from '@caldav-bridge/shared/utils';
import type { D1Queryable } from '../utils';
import { BaseDAO } from './BaseDAO';

const MAPPING_COLUMNS =
  'object_id, application_id, calendar_id, href, provider_event_id, uid, etag, deleted_at, sync_version, created_at, updated_at';

/** One mapping, by its CalDAV href. */
const SELECT_BY_HREF = `
  SELECT ${MAPPING_COLUMNS}
  FROM calendar_object_mappings
  WHERE application_id = ? AND calendar_id = ? AND href = ?
  LIMIT 1
`;

/** One mapping, by the provider's own event id. */
const SELECT_BY_PROVIDER_EVENT_ID = `
  SELECT ${MAPPING_COLUMNS}
  FROM calendar_object_mappings
  WHERE application_id = ? AND calendar_id = ? AND provider_event_id = ?
  LIMIT 1
`;

/** Every mapping in a collection, optionally including tombstones. */
const SELECT_BY_CALENDAR = `
  SELECT ${MAPPING_COLUMNS}
  FROM calendar_object_mappings
  WHERE application_id = ? AND calendar_id = ?
`;

/**
 * The changed window, `(since, through]`.
 *
 * The upper bound is not optional. A caller that selected "everything since the
 * client's token" and then read the new maximum to hand back as the next token
 * would report a window that had already closed: anything written in between
 * carries a version at or below that token while being absent from the results,
 * and because the next request asks for `> token`, the client never receives it.
 */
const SELECT_CHANGED = `
  SELECT ${MAPPING_COLUMNS}
  FROM calendar_object_mappings
  WHERE application_id = ? AND calendar_id = ? AND sync_version > ? AND sync_version <= ?
  ORDER BY sync_version, href
`;

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

class CalendarObjectMappingDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async getByHref(applicationId: string, calendarId: string, href: string): Promise<CalendarObjectMapping | undefined> {
    const row = await this.first<CalendarObjectMappingInternal>(SELECT_BY_HREF, [applicationId, calendarId, href]);
    return row ? this.toMapping(row) : undefined;
  }

  public async getByProviderEventId(
    applicationId: string,
    calendarId: string,
    providerEventId: string,
  ): Promise<CalendarObjectMapping | undefined> {
    const row = await this.first<CalendarObjectMappingInternal>(SELECT_BY_PROVIDER_EVENT_ID, [applicationId, calendarId, providerEventId]);
    return row ? this.toMapping(row) : undefined;
  }

  /**
   * Reconcile a whole calendar snapshot against what is stored, in one batch.
   *
   * This replaces a per-event read-modify-write that cost five D1 subrequests
   * each and ran unbounded in parallel. A 250-event calendar was 1250
   * subrequests, past Cloudflare's per-invocation limit, so the single most
   * common client operation -- an initial sync -- failed outright for most real
   * calendars. The same unbounded concurrency is what produced duplicate sync
   * versions: every event read the same `MAX(sync_version)`.
   *
   * Here the collection is read once, the counter is bumped once, and the whole
   * batch shares that single version, so the statements below are the only
   * subrequests a sync costs regardless of how many events it carries.
   */
  public async syncSnapshot(
    applicationId: string,
    calendarId: string,
    events: Array<{ href: string; providerEventId: string; uid: string; etag?: string | undefined }>,
  ): Promise<{ live: CalendarObjectMapping[]; deleted: CalendarObjectMapping[]; syncVersion: number }> {
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const existing = await this.listByCalendar(applicationId, calendarId, true);
    const existingByHref = new Map(existing.map((mapping) => [mapping.href, mapping]));
    const existingByProviderId = new Map(existing.map((mapping) => [mapping.providerEventId, mapping]));
    const seenProviderIds = new Set<string>();

    // Anything stored but absent from the snapshot was removed upstream. These
    // are the tombstones this sync introduces, which is what the caller reports
    // -- previously the whole retained tombstone set was re-read and re-sent on
    // every full snapshot, and folded into the collection tag, without bound.
    const tombstones = existing.filter(
      (mapping) => !mapping.deletedAt && !events.some((event) => event.providerEventId === mapping.providerEventId),
    );

    const changed: Array<{
      href: string;
      providerEventId: string;
      uid: string;
      etag?: string | undefined;
      objectId: string;
      insert: boolean;
    }> = [];
    for (const event of events) {
      seenProviderIds.add(event.providerEventId);
      const byHref = existingByHref.get(event.href);
      const byProviderId = existingByProviderId.get(event.providerEventId);
      const current = byHref ?? byProviderId;
      if (current && this.matchesSnapshot(current, event)) continue;
      changed.push({
        ...event,
        objectId: current?.objectId ?? UUIDUtil.getRandomUUID(),
        // A tombstone for this href is being brought back, so the insert path
        // has to clear `deleted_at` rather than collide with it.
        insert: !current || Boolean(current.deletedAt),
      });
    }

    const missing = tombstones.filter((mapping) => !seenProviderIds.has(mapping.providerEventId));
    // Nothing moved, so no version is issued -- but the caller still needs the
    // collection's live contents to answer a full-snapshot query.
    if (!changed.length && !missing.length) {
      const current = await this.listByCalendar(applicationId, calendarId);
      return { live: current, deleted: [], syncVersion: await this.getMaxSyncVersion(applicationId, calendarId) };
    }

    const syncVersion = await this.bumpSyncVersion(applicationId, calendarId);
    const statements: D1PreparedStatement[] = this.buildSyncStatements(
      applicationId,
      calendarId,
      changed,
      missing.map((mapping) => mapping.href),
      syncVersion,
      now,
    );
    await this.batch(statements);

    const synced = await this.listByCalendar(applicationId, calendarId, true);
    const syncedByHref = new Map(synced.map((mapping) => [mapping.href, mapping]));
    return {
      // Every live object, not just the ones this sync touched. A full snapshot
      // query asks for the whole collection, so returning only the delta would
      // answer a later request with an empty calendar.
      live: synced.filter((mapping) => !mapping.deletedAt),
      // Only what this sync removed, for the same reason the client is not told
      // about deletions it has already applied.
      deleted: missing.map((mapping) => syncedByHref.get(mapping.href) ?? { ...mapping, deletedAt: now, syncVersion }),
      syncVersion,
    };
  }

  private buildSyncStatements(
    applicationId: string,
    calendarId: string,
    changed: Array<{ href: string; providerEventId: string; uid: string; etag?: string | undefined; objectId: string; insert: boolean }>,
    deletedHrefs: string[],
    syncVersion: number,
    now: number,
  ): D1PreparedStatement[] {
    const statements: D1PreparedStatement[] = [];
    for (const event of changed) {
      const bindings: unknown[] = [
        event.objectId,
        applicationId,
        calendarId,
        event.href,
        event.providerEventId,
        event.uid,
        event.etag || null,
        syncVersion,
        now,
        now,
      ];
      const conflictTarget = event.insert
        ? 'ON CONFLICT(application_id, calendar_id, href) DO UPDATE SET provider_event_id = excluded.provider_event_id, uid = excluded.uid, etag = excluded.etag, deleted_at = NULL, sync_version = excluded.sync_version, updated_at = excluded.updated_at'
        : 'ON CONFLICT(object_id) DO UPDATE SET href = excluded.href, provider_event_id = excluded.provider_event_id, uid = excluded.uid, etag = excluded.etag, deleted_at = NULL, sync_version = excluded.sync_version, updated_at = excluded.updated_at';
      statements.push(
        this.statement(
          `
            INSERT INTO calendar_object_mappings
              (object_id, application_id, calendar_id, href, provider_event_id, uid, etag, deleted_at, sync_version, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
            ${conflictTarget}
          `,
          bindings,
        ),
      );
    }
    for (const href of deletedHrefs) {
      statements.push(
        this.statement(
          `
            UPDATE calendar_object_mappings
            SET deleted_at = ?, sync_version = ?, updated_at = ?
            WHERE application_id = ? AND calendar_id = ? AND href = ? AND deleted_at IS NULL
          `,
          [now, syncVersion, now, applicationId, calendarId, href],
        ),
      );
    }
    return statements;
  }

  public async upsert(
    applicationId: string,
    calendarId: string,
    href: string,
    providerEventId: string,
    uid: string,
    etag?: string,
  ): Promise<CalendarObjectMapping> {
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

    await this.run(
      `
        INSERT INTO calendar_object_mappings
          (object_id, application_id, calendar_id, href, provider_event_id, uid, etag, deleted_at, sync_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?)
      `,
      [UUIDUtil.getRandomUUID(), applicationId, calendarId, href, providerEventId, uid, etag || null, syncVersion, now, now],
    );
    const mapping = await this.getByHref(applicationId, calendarId, href);
    if (!mapping) throw new InternalServerError('Calendar object mapping vanished immediately after being written.');
    return mapping;
  }

  public async listByCalendar(applicationId: string, calendarId: string, includeDeleted = false): Promise<CalendarObjectMapping[]> {
    const sql = `${SELECT_BY_CALENDAR}${includeDeleted ? '' : ' AND deleted_at IS NULL'} ORDER BY href`;
    return (await this.all<CalendarObjectMappingInternal>(sql, [applicationId, calendarId])).map((row) => this.toMapping(row));
  }

  /**
   * The changes in `(since, through]`.
   *
   * The upper bound is not optional. A caller that selected "everything since
   * the client's token" and then read the new maximum to hand back as the next
   * token would report a window that had already closed: anything written in
   * between carries a version at or below that token while being absent from
   * the results, and because the next request asks for `> token`, the client
   * never receives it. Capturing the maximum first and then materialising
   * exactly that window is what keeps the token and its results in agreement.
   */
  public async listChangedBetween(
    applicationId: string,
    calendarId: string,
    since: number,
    through: number,
  ): Promise<CalendarObjectMapping[]> {
    const rows = await this.all<CalendarObjectMappingInternal>(SELECT_CHANGED, [applicationId, calendarId, since, through]);
    return rows.map((row) => this.toMapping(row));
  }

  /** Tombstone every live mapping whose provider event is no longer present. Returns the newly deleted set. */
  public async markMissingProviderEventsDeleted(
    applicationId: string,
    calendarId: string,
    providerEventIds: Set<string>,
  ): Promise<CalendarObjectMapping[]> {
    const liveMappings = await this.listByCalendar(applicationId, calendarId);
    const missingMappings = liveMappings.filter((mapping) => !providerEventIds.has(mapping.providerEventId));
    if (!missingMappings.length) return [];

    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const syncVersion = await this.bumpSyncVersion(applicationId, calendarId);
    await this.batch(
      missingMappings.map((mapping) =>
        this.statement(
          `
            UPDATE calendar_object_mappings
            SET deleted_at = ?, sync_version = ?, updated_at = ?
            WHERE application_id = ? AND calendar_id = ? AND href = ? AND deleted_at IS NULL
          `,
          [now, syncVersion, now, applicationId, calendarId, mapping.href],
        ),
      ),
    );
    return missingMappings.map((mapping) => ({ ...mapping, deletedAt: now, syncVersion }));
  }

  /**
   * The highest version this collection has issued.
   *
   * Read from the counter, not from `MAX(sync_version)`. A caller that uses this
   * as a sync token must capture it *before* selecting the changes it is
   * reporting, and then select the window it just captured -- otherwise a write
   * landing between the two reads is issued a version at or below the returned
   * token while being absent from the results, and the client will never be sent
   * it again.
   */
  public async getMaxSyncVersion(applicationId: string, calendarId: string): Promise<number> {
    const row = await this.first<{ version?: number | null }>(
      'SELECT version FROM calendar_sync_counters WHERE application_id = ? AND calendar_id = ?',
      [applicationId, calendarId],
    );
    return row?.version || 0;
  }

  /**
   * Allocate the next version for a collection.
   *
   * One `MAX + 1` per collection per sync, rather than one per object, so
   * concurrent syncs cannot collide. `UPDATE ... RETURNING` is a single
   * statement, so the read and the write cannot be interleaved by another
   * invocation.
   */
  public async bumpSyncVersion(applicationId: string, calendarId: string): Promise<number> {
    const row = await this.first<{ version?: number | null }>(
      `
        INSERT INTO calendar_sync_counters (application_id, calendar_id, version)
        VALUES (?, ?, 1)
        ON CONFLICT(application_id, calendar_id) DO UPDATE SET version = version + 1
        RETURNING version
      `,
      [applicationId, calendarId],
    );
    return row?.version ?? 1;
  }

  public async markDeletedByHref(applicationId: string, calendarId: string, href: string): Promise<CalendarObjectMapping | undefined> {
    const mapping = await this.getByHref(applicationId, calendarId, href);
    if (!mapping) return undefined;
    if (mapping.deletedAt) return mapping;
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const syncVersion = await this.bumpSyncVersion(applicationId, calendarId);
    await this.run(
      `
        UPDATE calendar_object_mappings
        SET deleted_at = ?, sync_version = ?, updated_at = ?
        WHERE application_id = ? AND calendar_id = ? AND href = ? AND deleted_at IS NULL
      `,
      [now, syncVersion, now, applicationId, calendarId, href],
    );
    return { ...mapping, deletedAt: now, syncVersion };
  }

  public async deleteDeletedBefore(cutoff: number, limit: number): Promise<number> {
    return this.deleteWhere(
      `
        DELETE FROM calendar_object_mappings
        WHERE object_id IN (
          SELECT object_id
          FROM calendar_object_mappings
          WHERE deleted_at IS NOT NULL AND deleted_at < ?
          LIMIT ?
        )
      `,
      [cutoff, limit],
    );
  }

  public async deleteOrphaned(limit: number): Promise<number> {
    return this.deleteWhere(
      `
        DELETE FROM calendar_object_mappings
        WHERE object_id IN (
          SELECT object_id
          FROM calendar_object_mappings
          WHERE application_id NOT IN (SELECT application_id FROM connected_applications)
          LIMIT ?
        )
      `,
      [limit],
    );
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
    return (
      mapping.providerEventId === providerEventId &&
      mapping.uid === uid &&
      (mapping.etag || null) === (etag || null) &&
      !mapping.deletedAt &&
      mapping.syncVersion > 0
    );
  }

  private matchesSnapshot(
    mapping: CalendarObjectMapping,
    event: { href: string; providerEventId: string; uid: string; etag?: string | undefined },
  ): boolean {
    return (
      !mapping.deletedAt &&
      mapping.href === event.href &&
      mapping.providerEventId === event.providerEventId &&
      mapping.uid === event.uid &&
      (mapping.etag || null) === (event.etag || null)
    );
  }

  private async updateByProviderEventId(
    applicationId: string,
    calendarId: string,
    providerEventId: string,
    uid: string,
    etag: string | undefined,
    now: number,
  ): Promise<CalendarObjectMapping> {
    const syncVersion = await this.bumpSyncVersion(applicationId, calendarId);
    await this.run(
      `
        UPDATE calendar_object_mappings
        SET uid = ?, etag = ?, deleted_at = null, sync_version = ?, updated_at = ?
        WHERE application_id = ? AND calendar_id = ? AND provider_event_id = ?
      `,
      [uid, etag || null, syncVersion, now, applicationId, calendarId, providerEventId],
    );
    const mapping = await this.getByProviderEventId(applicationId, calendarId, providerEventId);
    if (!mapping) throw new InternalServerError('Calendar object mapping vanished immediately after being updated.');
    return mapping;
  }

  private async updateByHref(
    applicationId: string,
    calendarId: string,
    href: string,
    providerEventId: string,
    uid: string,
    etag: string | undefined,
    now: number,
  ): Promise<CalendarObjectMapping> {
    const syncVersion = await this.bumpSyncVersion(applicationId, calendarId);
    await this.run(
      `
        UPDATE calendar_object_mappings
        SET provider_event_id = ?, uid = ?, etag = ?, deleted_at = null, sync_version = ?, updated_at = ?
        WHERE application_id = ? AND calendar_id = ? AND href = ?
      `,
      [providerEventId, uid, etag || null, syncVersion, now, applicationId, calendarId, href],
    );
    const mapping = await this.getByHref(applicationId, calendarId, href);
    if (!mapping) throw new InternalServerError('Calendar object mapping vanished immediately after being updated.');
    return mapping;
  }

  /**
   * A bounded delete, reported as the number of rows removed.
   *
   * The reapers in `DatabaseCleanupTask` branch on that count, so it is derived
   * from the driver's own result rather than assumed.
   */
  private async deleteWhere(sql: string, bindings: unknown[]): Promise<number> {
    const result = await this.run(sql, bindings);
    return result.meta?.changes ?? 0;
  }

  /**
   * Single-object writes still need a version, so they take one from the same
   * counter. `bumpSyncVersion` is a single statement and so cannot interleave
   * with another invocation's bump, which is what the previous
   * `MAX(sync_version) + 1` -- a read followed by a write -- allowed.
   */
  private async nextSyncVersion(applicationId: string, calendarId: string): Promise<number> {
    return this.bumpSyncVersion(applicationId, calendarId);
  }
}

export { CalendarObjectMappingDAO };
export type { CalendarObjectMapping };
