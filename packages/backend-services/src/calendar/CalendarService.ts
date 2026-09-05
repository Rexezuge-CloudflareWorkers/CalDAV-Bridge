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

  public async upsertEvent(
    application: ConnectedApplication,
    accessToken: string,
    calendarId: string,
    event: CalendarEvent,
    providerEventId?: string,
  ): Promise<CalendarEvent> {
    return CalendarProviderUtil.upsertEvent(application.providerId, accessToken, calendarId, event, providerEventId);
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

  public async upsertMappings(
    mappingDAO: CalendarObjectMappingDAO,
    applicationId: string,
    calendarId: string,
    events: CalendarEvent[],
  ): Promise<Array<{ href: string; event: CalendarEvent }>> {
    return Promise.all(
      events.map((event) =>
        mappingDAO
          .upsert(applicationId, calendarId, ICalendarUtil.eventHref(event), event.id || event.uid, event.uid, event.etag)
          .then((mapping) => ({ href: mapping.href, event, syncVersion: mapping.syncVersion })),
      ),
    );
  }

  public async syncProviderSnapshot(
    mappingDAO: CalendarObjectMappingDAO,
    applicationId: string,
    calendarId: string,
    events: CalendarEvent[],
  ): Promise<{ live: Array<{ href: string; event: CalendarEvent; syncVersion?: number | undefined }>; deleted: Array<{ href: string; status: number; syncVersion?: number | undefined }> }> {
    const live = await this.upsertMappings(mappingDAO, applicationId, calendarId, events);
    const providerEventIds = new Set(events.map((event) => event.id || event.uid));
    await mappingDAO.markMissingProviderEventsDeleted(applicationId, calendarId, providerEventIds);
    const deletedMappings = (await mappingDAO.listByCalendar(applicationId, calendarId, true)).filter((mapping) => mapping.deletedAt);
    return {
      live,
      deleted: deletedMappings.map((mapping) => ({ href: mapping.href, status: 404, syncVersion: mapping.syncVersion })),
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
