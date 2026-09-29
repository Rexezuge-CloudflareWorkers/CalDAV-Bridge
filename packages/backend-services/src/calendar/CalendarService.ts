import { CalendarObjectMappingDAO } from '@caldav-bridge/backend-data/dao';
import type { CalendarObjectMapping } from '@caldav-bridge/backend-data/dao';
import type { D1Queryable } from '@caldav-bridge/backend-data/utils';
import { ForbiddenError, NotFoundError } from '@caldav-bridge/backend-errors';
import { CalendarProviderUtil } from '@caldav-bridge/provider-clients/calendar';
import type { CalendarEvent, ConnectedApplication, ProviderCalendar } from '@caldav-bridge/shared/model';
import { OAuth2AccessTokenService } from '../oauth2/OAuth2AccessTokenService';
import { CalDavUtil } from './CalDavUtil';
import { ICalendarUtil } from './ICalendarUtil';

interface CalendarServiceEnv {
  DB: D1Queryable;
  AES_ENCRYPTION_KEY_SECRET: { get(): Promise<string> };
  OAUTH2_TOKEN_CACHE: KVNamespace;
}

class CalendarService {
  constructor(private readonly env: CalendarServiceEnv) {}

  public async getAccessToken(applicationId: string): Promise<string> {
    return OAuth2AccessTokenService.getAccessToken(applicationId, this.env);
  }

  public async listCalendars(application: ConnectedApplication): Promise<ProviderCalendar[]> {
    const accessToken = await OAuth2AccessTokenService.getAccessToken(application.applicationId, this.env);
    return CalendarProviderUtil.listCalendars(application.providerId, accessToken);
  }

  public async listEvents(
    application: ConnectedApplication,
    accessToken: string,
    calendarId: string,
    range?: { start?: string | undefined; end?: string | undefined },
  ): Promise<CalendarEvent[]> {
    return CalendarProviderUtil.listEvents(application.providerId, accessToken, calendarId, range ?? {});
  }

  /**
   * Write an event to the provider.
   *
   * `expectedEtag` is the etag the bridge last observed for this object, and is
   * forwarded as a conditional write. Without it, a change made in the
   * provider's own UI between that read and this one was overwritten with no
   * `412` anywhere -- the client's `If-Match` was expressing precisely that
   * intent, and it was being dropped.
   */
  public async upsertEvent(
    application: ConnectedApplication,
    accessToken: string,
    calendarId: string,
    event: CalendarEvent,
    providerEventId?: string,
    expectedEtag?: string,
  ): Promise<CalendarEvent> {
    return CalendarProviderUtil.upsertEvent(application.providerId, accessToken, calendarId, event, providerEventId, expectedEtag);
  }

  public async deleteEvent(application: ConnectedApplication, accessToken: string, calendarId: string, providerEventId: string): Promise<void> {
    return CalendarProviderUtil.deleteEvent(application.providerId, accessToken, calendarId, providerEventId);
  }

  public async getDavObject(
    application: ConnectedApplication,
    accessToken: string,
    mappingDAO: CalendarObjectMappingDAO,
    calendarId: string,
    objectHref: string,
  ): Promise<CalendarEvent> {
    const mapping = await mappingDAO.getByHref(application.applicationId, calendarId, objectHref);
    if (mapping?.deletedAt) throw new NotFoundError('Calendar object was deleted.');
    const providerEventId = mapping?.providerEventId || CalDavUtil.providerEventIdFromObjectHref(objectHref);
    const event = await CalendarProviderUtil.getEvent(application.providerId, accessToken, calendarId, providerEventId);
    await mappingDAO.upsert(application.applicationId, calendarId, objectHref, event.id || providerEventId, event.uid, event.etag);
    return event;
  }

  public async requireCalendar(application: ConnectedApplication, accessToken: string, calendarId: string): Promise<ProviderCalendar> {
    const calendar = (await CalendarProviderUtil.listCalendars(application.providerId, accessToken)).find((item) => item.id === calendarId);
    if (!calendar) throw new NotFoundError('Calendar collection was not found.');
    return calendar;
  }

  public async requireWritableCalendar(application: ConnectedApplication, accessToken: string, calendarId: string): Promise<void> {
    const calendar = await this.requireCalendar(application, accessToken, calendarId);
    if (calendar.readOnly) throw new ForbiddenError('Calendar collection is read-only.');
  }

  /**
   * Reconcile a provider snapshot against the stored mappings.
   *
   * The whole reconciliation is one DAO call, which is what keeps a full sync
   * inside the platform's subrequest budget: the previous per-event
   * read-modify-write cost five subrequests each and ran unbounded in parallel,
   * so a calendar of a few hundred events could not sync at all.
   *
   * `deleted` is the delta this sync produced, not every tombstone ever
   * retained. Reporting the retained set meant a long-lived calendar emitted a
   * `404` element for every object that had disappeared months ago, on every
   * full query, and folded all of them into the collection tag.
   */
  public async syncProviderSnapshot(
    mappingDAO: CalendarObjectMappingDAO,
    applicationId: string,
    calendarId: string,
    events: CalendarEvent[],
  ): Promise<{ live: Array<{ href: string; event: CalendarEvent; syncVersion?: number | undefined }>; deleted: Array<{ href: string; status: number; syncVersion?: number | undefined }>; syncVersion: number }> {
    const snapshot = events.map((event) => ({
      href: ICalendarUtil.eventHref(event),
      providerEventId: event.id || event.uid,
      uid: event.uid,
      etag: event.etag,
    }));
    const result = await mappingDAO.syncSnapshot(applicationId, calendarId, snapshot);
    const eventByHref = new Map(snapshot.map((event, index) => [event.href, events[index] as CalendarEvent]));
    return {
      live: result.live
        .map((mapping) => {
          const event = eventByHref.get(mapping.href);
          return event ? { href: mapping.href, event, syncVersion: mapping.syncVersion } : undefined;
        })
        .filter((entry): entry is { href: string; event: CalendarEvent; syncVersion: number } => Boolean(entry)),
      deleted: result.deleted.map((mapping) => ({ href: mapping.href, status: 404, syncVersion: mapping.syncVersion })),
      syncVersion: result.syncVersion,
    };
  }

  public mappingsToReportResults(
    mappings: CalendarObjectMapping[],
    eventByProviderId: Map<string, CalendarEvent>,
  ): Array<{ href: string; event?: CalendarEvent | undefined; status?: number | undefined; syncVersion?: number | undefined }> {
    return mappings.map((mapping) => {
      if (mapping.deletedAt) return { href: mapping.href, status: 404, syncVersion: mapping.syncVersion };
      const event = eventByProviderId.get(mapping.providerEventId);
      return event ? { href: mapping.href, event, syncVersion: mapping.syncVersion } : { href: mapping.href, status: 404, syncVersion: mapping.syncVersion };
    });
  }
}

export { CalendarService };
export type { CalendarServiceEnv };
