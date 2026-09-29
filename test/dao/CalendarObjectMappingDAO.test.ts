import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { CalendarObjectMappingDAO } from '@caldav-bridge/backend-data/dao';
import { asD1Queryable, countingD1Queryable } from '../helpers/d1';
import { applyMigrations } from '../helpers/migrations';

const APP = 'app-1';
const CAL = 'cal-1';

/**
 * These run against a real SQLite engine rather than a hand-written fake, so a
 * query the database would reject fails here too. That matters more than usual
 * for this DAO: it now leans on `ON CONFLICT` targets, `RETURNING` and
 * `database.batch()`, and a fake free to drift from the schema would happily
 * pass a statement SQLite refuses.
 */
describe('CalendarObjectMappingDAO', () => {
  let database: DatabaseSync;
  let dao: CalendarObjectMappingDAO;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database);
    seedApplication(database);
    dao = new CalendarObjectMappingDAO(asD1Queryable(database));
  });

  it('preserves a local CalDAV href when provider sync sees the same event id', async () => {
    const local = await dao.upsert(APP, CAL, 'local-created.ics', 'provider-event-1', 'uid-1', 'etag-1');

    const synced = await dao.upsert(APP, CAL, 'provider-event-1.ics', 'provider-event-1', 'uid-1', 'etag-2');

    expect(local.href).toBe('local-created.ics');
    expect(synced.href).toBe('local-created.ics');
    expect(synced.etag).toBe('etag-2');
    expect(await dao.listByCalendar(APP, CAL)).toHaveLength(1);
  });

  it('marks missing provider events as deleted and restores them on upsert', async () => {
    await dao.upsert(APP, CAL, 'one.ics', 'provider-one', 'uid-1', 'etag-1');
    await dao.upsert(APP, CAL, 'two.ics', 'provider-two', 'uid-2', 'etag-2');

    const deleted = await dao.markMissingProviderEventsDeleted(APP, CAL, new Set(['provider-two']));

    expect(deleted.map((mapping) => mapping.href)).toEqual(['one.ics']);
    expect((await dao.getByHref(APP, CAL, 'one.ics'))?.deletedAt).toBeTruthy();

    const restored = await dao.upsert(APP, CAL, 'one.ics', 'provider-one', 'uid-1', 'etag-3');

    expect(restored.deletedAt).toBeNull();
    expect(restored.etag).toBe('etag-3');
    expect(await dao.listByCalendar(APP, CAL)).toHaveLength(2);
  });

  it('marks local deletes as sync tombstones', async () => {
    await dao.upsert(APP, CAL, 'one.ics', 'provider-one', 'uid-1', 'etag-1');

    const deleted = await dao.markDeletedByHref(APP, CAL, 'one.ics');

    expect(deleted?.deletedAt).toBeTruthy();
    expect(await dao.listByCalendar(APP, CAL)).toEqual([]);
  });

  describe('sync version allocation', () => {
    /**
     * Versions used to be `MAX(sync_version) + 1` per row, read and written
     * independently. Two allocations could therefore return the same number, and
     * a version already handed to a client could be re-issued to a different
     * object -- so that client's next `> token` query would skip it forever.
     */
    it('never issues the same version twice', async () => {
      const versions = await Promise.all([dao.bumpSyncVersion(APP, CAL), dao.bumpSyncVersion(APP, CAL), dao.bumpSyncVersion(APP, CAL)]);

      expect(new Set(versions).size).toBe(3);
      expect([...versions].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    });

    it('keeps each collection on its own counter', async () => {
      await dao.bumpSyncVersion(APP, CAL);

      expect(await dao.bumpSyncVersion(APP, 'cal-2')).toBe(1);
      expect(await dao.getMaxSyncVersion(APP, CAL)).toBe(1);
      expect(await dao.getMaxSyncVersion(APP, 'cal-2')).toBe(1);
    });

    it('stamps one shared version across a whole snapshot', async () => {
      const result = await dao.syncSnapshot(APP, CAL, [
        { href: 'a.ics', providerEventId: 'pa', uid: 'ua', etag: 'e1' },
        { href: 'b.ics', providerEventId: 'pb', uid: 'ub', etag: 'e2' },
        { href: 'c.ics', providerEventId: 'pc', uid: 'uc', etag: 'e3' },
      ]);

      expect(new Set([...result.live, ...result.deleted].map((mapping) => mapping.syncVersion)).size).toBe(1);
      expect(result.syncVersion).toBe(1);
    });

    it('leaves an unchanged snapshot without issuing a version', async () => {
      const events = [{ href: 'a.ics', providerEventId: 'pa', uid: 'ua', etag: 'e1' }];
      await dao.syncSnapshot(APP, CAL, events);

      const second = await dao.syncSnapshot(APP, CAL, events);

      // No version, and no new tombstones -- but the live contents are still
      // returned, because a full-snapshot query asks for the whole collection
      // and an answer of "nothing changed" would be an empty calendar.
      expect(second.deleted).toEqual([]);
      expect(second.live.map((mapping) => mapping.href)).toEqual(['a.ics']);
      expect(second.syncVersion).toBe(1);
    });
  });

  /**
   * The load-bearing invariant of the whole sync design: the token a client is
   * handed must never be newer than the changes it was just sent. When it was,
   * a write landing between the change query and the max-version read was
   * permanently invisible to that client.
   */
  describe('sync windows', () => {
    it('reports every change issued inside the captured window', async () => {
      await dao.syncSnapshot(APP, CAL, [
        { href: 'a.ics', providerEventId: 'pa', uid: 'ua', etag: 'e1' },
        { href: 'b.ics', providerEventId: 'pb', uid: 'ub', etag: 'e2' },
      ]);

      const through = await dao.bumpSyncVersion(APP, CAL);
      const changes = await dao.listChangedBetween(APP, CAL, 0, through);

      expect(changes.map((mapping) => mapping.href).sort()).toEqual(['a.ics', 'b.ics']);
      // Every reported change sits at or below the ceiling being handed back.
      expect(changes.every((mapping) => mapping.syncVersion <= through)).toBe(true);
    });

    it('excludes writes issued after the captured ceiling', async () => {
      await dao.syncSnapshot(APP, CAL, [{ href: 'a.ics', providerEventId: 'pa', uid: 'ua', etag: 'e1' }]);
      const through = await dao.getMaxSyncVersion(APP, CAL);

      // A write lands after the client was served. The next sync must still see
      // it, which it only can if the first response's token did not cover it.
      await dao.upsert(APP, CAL, 'late.ics', 'plate', 'ulate', 'e-late');
      const laterThrough = await dao.getMaxSyncVersion(APP, CAL);

      expect((await dao.listChangedBetween(APP, CAL, 0, through)).map((m) => m.href)).toEqual(['a.ics']);
      expect((await dao.listChangedBetween(APP, CAL, through, laterThrough)).map((m) => m.href)).toEqual(['late.ics']);
    });

    it('reports a change exactly once across consecutive windows', async () => {
      await dao.syncSnapshot(APP, CAL, [{ href: 'a.ics', providerEventId: 'pa', uid: 'ua', etag: 'e1' }]);
      const first = await dao.getMaxSyncVersion(APP, CAL);
      const second = await dao.bumpSyncVersion(APP, CAL);

      expect(await dao.listChangedBetween(APP, CAL, 0, first)).toHaveLength(1);
      expect(await dao.listChangedBetween(APP, CAL, first, second)).toHaveLength(0);
    });
  });

  describe('syncSnapshot', () => {
    it('tombstones only what this snapshot removed, not every retained tombstone', async () => {
      await dao.syncSnapshot(APP, CAL, [
        { href: 'a.ics', providerEventId: 'pa', uid: 'ua', etag: 'e1' },
        { href: 'b.ics', providerEventId: 'pb', uid: 'ub', etag: 'e2' },
      ]);
      // First removal: reported.
      const first = await dao.syncSnapshot(APP, CAL, [{ href: 'a.ics', providerEventId: 'pa', uid: 'ua', etag: 'e1' }]);
      expect(first.deleted.map((mapping) => mapping.href)).toEqual(['b.ics']);
      // Second removal: only the new one. Re-reporting 'b' would tell the client
      // about a deletion it was already told about, on every full sync, forever.
      const second = await dao.syncSnapshot(APP, CAL, []);
      expect(second.deleted.map((mapping) => mapping.href)).toEqual(['a.ics']);
      const third = await dao.syncSnapshot(APP, CAL, []);
      expect(third.deleted).toEqual([]);
    });

    it('reuses the stored row rather than colliding when an href reappears', async () => {
      await dao.syncSnapshot(APP, CAL, [{ href: 'a.ics', providerEventId: 'pa', uid: 'ua', etag: 'e1' }]);
      await dao.syncSnapshot(APP, CAL, []);

      const restored = await dao.syncSnapshot(APP, CAL, [{ href: 'a.ics', providerEventId: 'pa', uid: 'ua', etag: 'e9' }]);

      expect(restored.live).toHaveLength(1);
      expect(restored.live[0]?.deletedAt).toBeNull();
      expect(restored.live[0]?.etag).toBe('e9');
      expect(await dao.listByCalendar(APP, CAL)).toHaveLength(1);
    });

    it('scopes a snapshot to the collection it was given', async () => {
      await dao.syncSnapshot(APP, CAL, [{ href: 'a.ics', providerEventId: 'pa', uid: 'ua', etag: 'e1' }]);
      await dao.syncSnapshot(APP, 'cal-2', [{ href: 'z.ics', providerEventId: 'pz', uid: 'uz', etag: 'e1' }]);

      // `cal-2`'s single event is not "missing" from `cal-1`; the two counters
      // and the two mapping sets are independent.
      const second = await dao.syncSnapshot(APP, CAL, [{ href: 'a.ics', providerEventId: 'pa', uid: 'ua', etag: 'e1' }]);

      expect(second.deleted).toEqual([]);
      expect((await dao.listByCalendar(APP, CAL)).map((mapping) => mapping.href)).toEqual(['a.ics']);
      expect((await dao.listByCalendar(APP, 'cal-2')).map((mapping) => mapping.href)).toEqual(['z.ics']);
    });

    it('scales its subrequest count with the batch, not with the event count', async () => {
      const events = Array.from({ length: 400 }, (_, index) => ({
        href: `event-${index}.ics`,
        providerEventId: `provider-${index}`,
        uid: `uid-${index}`,
        etag: `etag-${index}`,
      }));

      const counting = countingD1Queryable(database);
      const counted = new CalendarObjectMappingDAO(counting.database);

      await counted.syncSnapshot(APP, CAL, events);

      // One read, one counter bump, one batch of writes, one read-back. The
      // previous implementation cost five subrequests per event, so 400 events
      // meant 2000 -- past the platform's per-invocation limit, which is why
      // initial syncs of real calendars failed outright.
      expect(counting.subrequests()).toBeLessThan(10);
    });
  });
});

function seedApplication(database: DatabaseSync): void {
  database
    .prepare('INSERT INTO users (email, created_at, updated_at, user_id, current_email) VALUES (?, ?, ?, ?, ?)')
    .run('owner@example.com', 100, 100, 'user-1', 'owner@example.com');
  database
    .prepare(
      `INSERT INTO connected_applications
        (application_id, user_email, user_id, display_name, provider_id, connection_method,
         encrypted_credentials, credentials_iv, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'google-calendar', 'oauth2', 'enc', 'iv', 'connected', 100, 100)`,
    )
    .run(APP, 'owner@example.com', 'user-1', 'Test Application');
}
