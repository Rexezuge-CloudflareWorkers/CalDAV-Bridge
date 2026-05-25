import { Hono } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  CONNECTED_APPLICATION_STATUS_CONNECTED,
  DEFAULT_DEFAULT_CALDAV_CREDENTIAL_EXPIRY_DAYS,
  DEFAULT_MAX_APPLICATIONS_PER_USER,
  DEFAULT_MAX_CALDAV_CREDENTIALS_PER_APPLICATION,
  DEFAULT_MAX_CALDAV_CREDENTIAL_EXPIRY_DAYS,
  DEFAULT_OAUTH2_STATE_EXPIRY_MINUTES,
} from '@caldav-bridge/shared/constants';
import { CalDavCredentialUtil, TimestampUtil } from '@caldav-bridge/shared/utils';
import type { CalendarEvent, ConnectedApplication, ConnectedApplicationMetadata, ProviderCalendar } from '@caldav-bridge/shared/model';
import { validateRequestInput } from '@caldav-bridge/shared/schema';
import { CalDavCredentialDAO, CalendarObjectMappingDAO, ConnectedApplicationDAO, OAuth2AuthorizationSessionDAO, UserDAO } from '@/dao';
import type { CalendarObjectMapping } from '@/dao';
import {
  BaseUrlUtil,
  CalDavUtil,
  CalendarProviderUtil,
  ConfigurationUtil,
  errorResponse,
  HttpError,
  ICalendarUtil,
  jsonResponse,
  OAuth2AccessTokenService,
  OAuth2ProviderUtil,
  OAuth2StateUtil,
} from '@/utils';
import { SPA_HTML } from '@/generated/spa-shell';

class CalDavBridgeWorker {
  private readonly app: Hono<{ Bindings: Env }>;

  constructor() {
    const app = new Hono<{ Bindings: Env }>();
    app.get('/', (c) => c.redirect('/user/'));
    app.get('/.well-known/caldav', (c) => c.redirect('/dav/', 301));
    app.options('/user/*', () => new Response(null, { status: 204, headers: corsHeaders() }));

    app.get('/user/me', async (c) => safe(() => this.getCurrentUser(c.req.raw, c.env)));
    app.get('/user/applications', async (c) => safe(() => this.listApplications(c.req.raw, c.env)));
    app.post('/user/application', async (c) => safe(() => this.createApplication(c.req.raw, c.env)));
    app.put('/user/application', async (c) => safe(() => this.updateApplication(c.req.raw, c.env)));
    app.delete('/user/application', async (c) => safe(() => this.deleteApplication(c.req.raw, c.env)));
    app.post('/user/application/oauth2/authorize', async (c) => safe(() => this.createOAuth2Authorization(c.req.raw, c.env)));
    app.get('/user/application/calendars', async (c) => safe(() => this.listCalendars(c.req.raw, c.env)));
    app.get('/user/application/caldav-credentials', async (c) => safe(() => this.listCalDavCredentials(c.req.raw, c.env)));
    app.post('/user/application/caldav-credential', async (c) => safe(() => this.createCalDavCredential(c.req.raw, c.env)));
    app.delete('/user/application/caldav-credential', async (c) => safe(() => this.deleteCalDavCredential(c.req.raw, c.env)));
    app.get('/api/oauth2/callback/:applicationId', async (c) =>
      safe(() => this.oauth2Callback(c.req.raw, c.env, c.req.param('applicationId'))),
    );

    app.all('/dav', async (c) => safeDav(() => this.handleDav(c.req.raw, c.env)));
    app.all('/dav/*', async (c) => safeDav(() => this.handleDav(c.req.raw, c.env)));
    app.get('/user/*', (c) => (ConfigurationUtil.getServeSpaFromWorker(c.env) ? c.html(SPA_HTML) : c.notFound()));
    this.app = app;
  }

  public fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return Promise.resolve(this.app.fetch(request, env, ctx));
  }

  public scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cronTasksId = env.CRON_TASKS.idFromName('global');
    const cronTasksStub = env.CRON_TASKS.get(cronTasksId);
    const cronTasksRequest = new Request('https://cron-tasks.internal/run', {
      method: 'POST',
      body: JSON.stringify({ cron: controller.cron, scheduledTime: controller.scheduledTime }),
    });

    ctx.waitUntil(
      cronTasksStub
        .fetch(cronTasksRequest)
        .then(async (response) => {
          if (!response.ok && response.status !== 202) console.error('CronTasksWorker returned an error response:', response.status, await response.text());
        })
        .catch((error: unknown) => {
          console.error('Failed to invoke CronTasksWorker:', error);
        }),
    );
    return Promise.resolve();
  }

  private async getCurrentUser(request: Request, env: Env): Promise<Response> {
    const email = await this.requireUserEmail(request, env);
    await new UserDAO(env.DB).ensure(email);
    return jsonResponse({
      email,
      limits: {
        maxApplicationsPerUser: ConfigurationUtil.getPositiveInteger(env.MAX_APPLICATIONS_PER_USER, DEFAULT_MAX_APPLICATIONS_PER_USER),
        maxCalDavCredentialsPerApplication: ConfigurationUtil.getPositiveInteger(
          env.MAX_CALDAV_CREDENTIALS_PER_APPLICATION,
          DEFAULT_MAX_CALDAV_CREDENTIALS_PER_APPLICATION,
        ),
        defaultCalDavCredentialExpiryDays: ConfigurationUtil.getPositiveInteger(
          env.DEFAULT_CALDAV_CREDENTIAL_EXPIRY_DAYS,
          DEFAULT_DEFAULT_CALDAV_CREDENTIAL_EXPIRY_DAYS,
        ),
      },
    });
  }

  private async listApplications(request: Request, env: Env): Promise<Response> {
    const email = await this.requireUserEmail(request, env);
    const applicationDAO = await this.applicationDAO(env);
    const credentialDAO = new CalDavCredentialDAO(env.DB);
    const applications = await Promise.all(
      (await applicationDAO.listMetadataByUserEmail(email)).map(async (application) =>
        this.decorateApplication(request, application, credentialDAO),
      ),
    );
    return jsonResponse({ applications });
  }

  private async createApplication(request: Request, env: Env): Promise<Response> {
    const body = await this.validatedBody<CreateApplicationInput>(request);
    const email = await this.requireUserEmail(request, env);
    await new UserDAO(env.DB).ensure(email);
    const applicationDAO = await this.applicationDAO(env);
    const maxApplications = ConfigurationUtil.getPositiveInteger(env.MAX_APPLICATIONS_PER_USER, DEFAULT_MAX_APPLICATIONS_PER_USER);
    if ((await applicationDAO.countByUserEmail(email)) >= maxApplications)
      throw new HttpError(400, `Maximum ${maxApplications} applications allowed per user.`);
    const application = await applicationDAO.create(email, body.displayName, body.providerId, {
      clientId: body.clientId,
      clientSecret: body.clientSecret,
    });
    return jsonResponse({ application: await this.decorateApplication(request, application, new CalDavCredentialDAO(env.DB)) });
  }

  private async updateApplication(request: Request, env: Env): Promise<Response> {
    const body = await this.validatedBody<CreateApplicationInput & { applicationId: string }>(request);
    const email = await this.requireUserEmail(request, env);
    const applicationDAO = await this.applicationDAO(env);
    const application = await applicationDAO.updateForUser(body.applicationId, email, body.displayName, {
      clientId: body.clientId,
      clientSecret: body.clientSecret,
    });
    if (!application) throw new HttpError(404, 'Connected application was not found.');
    return jsonResponse({ application: await this.decorateApplication(request, application, new CalDavCredentialDAO(env.DB)) });
  }

  private async deleteApplication(request: Request, env: Env): Promise<Response> {
    const body = await this.validatedBody<{ applicationId: string }>(request);
    const email = await this.requireUserEmail(request, env);
    await (await this.applicationDAO(env)).deleteForUser(body.applicationId, email);
    return jsonResponse({ success: true });
  }

  private async createOAuth2Authorization(request: Request, env: Env): Promise<Response> {
    const body = await this.validatedBody<{ applicationId: string }>(request);
    const email = await this.requireUserEmail(request, env);
    const application = await (await this.applicationDAO(env)).getByIdForUser(body.applicationId, email);
    if (!application) throw new HttpError(404, 'Connected application was not found.');
    const state = OAuth2StateUtil.generateState();
    const codeVerifier = OAuth2StateUtil.generateCodeVerifier();
    const codeChallenge = await OAuth2StateUtil.getCodeChallenge(codeVerifier);
    const redirectUri = `${BaseUrlUtil.getBaseUrl(request)}/api/oauth2/callback/${application.applicationId}`;
    const expiresAt = TimestampUtil.addMinutes(
      TimestampUtil.getCurrentUnixTimestampInSeconds(),
      ConfigurationUtil.getPositiveInteger(env.OAUTH2_STATE_EXPIRY_MINUTES, DEFAULT_OAUTH2_STATE_EXPIRY_MINUTES),
    );
    await new OAuth2AuthorizationSessionDAO(env.DB).create(
      application.applicationId,
      await OAuth2StateUtil.getStateHash(state),
      codeVerifier,
      redirectUri,
      expiresAt,
    );
    return jsonResponse({
      authorizationUrl: OAuth2ProviderUtil.buildAuthorizationUrl({
        providerId: application.providerId,
        clientId: application.credentials.clientId,
        redirectUri,
        state,
        codeChallenge,
      }),
      redirectUri,
      expiresAt,
    });
  }

  private async oauth2Callback(request: Request, env: Env, applicationId?: string): Promise<Response> {
    if (!applicationId) throw new HttpError(400, 'OAuth2 callback is missing applicationId.');
    const url = new URL(request.url);
    const error = url.searchParams.get('error');
    if (error) return redirect(`/user?oauth2=error&message=${encodeURIComponent(error)}`);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) throw new HttpError(400, 'OAuth2 callback is missing code or state.');
    const sessionDAO = new OAuth2AuthorizationSessionDAO(env.DB);
    const session = await sessionDAO.getActive(applicationId, await OAuth2StateUtil.getStateHash(state));
    if (!session) throw new HttpError(400, 'OAuth2 authorization session is invalid or expired.');
    await OAuth2AccessTokenService.completeAuthorization(applicationId, session.redirectUri, code, session.codeVerifier, env);
    await sessionDAO.consume(session.sessionId);
    return redirect(`/user?oauth2=connected&applicationId=${encodeURIComponent(applicationId)}`);
  }

  private async listCalendars(request: Request, env: Env): Promise<Response> {
    const application = await this.requireUserApplicationFromQuery(request, env);
    const accessToken = await OAuth2AccessTokenService.getAccessToken(application.applicationId, env);
    return jsonResponse({ calendars: await CalendarProviderUtil.listCalendars(application.providerId, accessToken) });
  }

  private async listCalDavCredentials(request: Request, env: Env): Promise<Response> {
    const application = await this.requireUserApplicationFromQuery(request, env);
    return jsonResponse({ credentials: await new CalDavCredentialDAO(env.DB).listByApplication(application.applicationId) });
  }

  private async createCalDavCredential(request: Request, env: Env): Promise<Response> {
    const body = await this.validatedBody<{ applicationId: string; name: string; expiresInDays?: number }>(request);
    const application = await this.requireUserApplication(request, env, body.applicationId);
    if (application.status !== CONNECTED_APPLICATION_STATUS_CONNECTED)
      throw new HttpError(400, 'Connect OAuth2 before creating CalDAV credentials.');
    const credentialDAO = new CalDavCredentialDAO(env.DB);
    const maxCredentials = ConfigurationUtil.getPositiveInteger(
      env.MAX_CALDAV_CREDENTIALS_PER_APPLICATION,
      DEFAULT_MAX_CALDAV_CREDENTIALS_PER_APPLICATION,
    );
    if ((await credentialDAO.countByApplication(application.applicationId)) >= maxCredentials)
      throw new HttpError(400, `Maximum ${maxCredentials} CalDAV credentials allowed per application.`);
    const defaultDays = ConfigurationUtil.getPositiveInteger(
      env.DEFAULT_CALDAV_CREDENTIAL_EXPIRY_DAYS,
      DEFAULT_DEFAULT_CALDAV_CREDENTIAL_EXPIRY_DAYS,
    );
    const maxDays = ConfigurationUtil.getPositiveInteger(env.MAX_CALDAV_CREDENTIAL_EXPIRY_DAYS, DEFAULT_MAX_CALDAV_CREDENTIAL_EXPIRY_DAYS);
    const expiresInDays = body.expiresInDays || defaultDays;
    if (expiresInDays > maxDays) throw new HttpError(400, `CalDAV credential expiry cannot exceed ${maxDays} days.`);
    const password = CalDavCredentialUtil.generatePassword();
    const passwordHash = await CalDavCredentialUtil.hashPassword(password);
    const expiresAt = TimestampUtil.addDays(TimestampUtil.getCurrentUnixTimestampInSeconds(), expiresInDays);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const username = CalDavCredentialUtil.generateUsername();
      if (await credentialDAO.usernameExists(username)) continue;
      try {
        const metadata = await credentialDAO.create(
          application.applicationId,
          username,
          passwordHash,
          body.name,
          CalDavCredentialUtil.getPrefix(password),
          CalDavCredentialUtil.getLastFour(password),
          expiresAt,
        );
        return jsonResponse({ password, metadata });
      } catch (error) {
        if (!this.isUniqueConstraintError(error)) throw error;
      }
    }
    throw new HttpError(500, 'Failed to generate a unique CalDAV username.');
  }

  private async deleteCalDavCredential(request: Request, env: Env): Promise<Response> {
    const body = await this.validatedBody<{ applicationId: string; credentialId: string }>(request);
    const application = await this.requireUserApplication(request, env, body.applicationId);
    await new CalDavCredentialDAO(env.DB).deleteForApplication(body.credentialId, application.applicationId);
    return jsonResponse({ success: true });
  }

  private async handleDav(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return CalDavUtil.options();
    const url = new URL(request.url);
    const path = CalDavUtil.parsePath(url.pathname);
    if (path.resource === 'unknown') return CalDavUtil.notFound(url.pathname);
    const application = await this.authenticateDav(request, env, path.applicationId);
    const mappingDAO = new CalendarObjectMappingDAO(env.DB);

    if (request.method === 'PROPFIND') return this.handleDavPropfind(request, env, application, path, mappingDAO);
    if (request.method === 'REPORT') return this.handleDavReport(request, env, application, path, mappingDAO);

    if (path.resource !== 'object' || !path.calendarId || !path.objectHref)
      throw new HttpError(405, 'Unsupported CalDAV method for this resource.');

    const accessToken = await OAuth2AccessTokenService.getAccessToken(application.applicationId, env);
    if (request.method === 'GET' || request.method === 'HEAD') {
      const event = await this.getDavObject(application, accessToken, mappingDAO, path.calendarId, path.objectHref);
      if (request.method === 'HEAD') return CalDavUtil.headCalendarResponse(event);
      return CalDavUtil.textCalendarResponse(ICalendarUtil.toICS(event), event.etag || event.uid);
    }

    if (request.method === 'PUT') {
      await this.requireWritableCalendar(application, accessToken, path.calendarId);
      const mapping = await mappingDAO.getByHref(application.applicationId, path.calendarId, path.objectHref);
      const liveMapping = mapping?.deletedAt ? undefined : mapping;
      if (request.headers.get('If-None-Match')?.trim() === '*' && liveMapping) throw new HttpError(412, 'Calendar object already exists.');
      if (!CalDavUtil.etagMatches(request.headers.get('If-Match'), liveMapping?.etag || undefined))
        throw new HttpError(412, 'Calendar object ETag does not match.');
      const event = ICalendarUtil.fromICS(await request.text(), liveMapping?.uid || crypto.randomUUID());
      const saved = await CalendarProviderUtil.upsertEvent(
        application.providerId,
        accessToken,
        path.calendarId,
        event,
        liveMapping?.providerEventId,
      );
      await mappingDAO.upsert(application.applicationId, path.calendarId, path.objectHref, saved.id || event.uid, saved.uid, saved.etag);
      return new Response(null, { status: liveMapping ? 204 : 201, headers: { ETag: CalDavUtil.eventEtag(saved), Location: url.pathname } });
    }
    if (request.method === 'DELETE') {
      await this.requireWritableCalendar(application, accessToken, path.calendarId);
      const mapping = await mappingDAO.getByHref(application.applicationId, path.calendarId, path.objectHref);
      if (!CalDavUtil.etagMatches(request.headers.get('If-Match'), mapping?.etag || undefined))
        throw new HttpError(412, 'Calendar object ETag does not match.');
      const providerEventId = mapping?.providerEventId || CalDavUtil.providerEventIdFromObjectHref(path.objectHref);
      await CalendarProviderUtil.deleteEvent(application.providerId, accessToken, path.calendarId, providerEventId);
      await mappingDAO.markDeletedByHref(application.applicationId, path.calendarId, path.objectHref);
      return new Response(null, { status: 204 });
    }
    throw new HttpError(405, 'Unsupported CalDAV method.');
  }

  private async handleDavPropfind(
    request: Request,
    env: Env,
    application: ConnectedApplication,
    path: ReturnType<typeof CalDavUtil.parsePath>,
    mappingDAO: CalendarObjectMappingDAO,
  ): Promise<Response> {
    const propfind = CalDavUtil.parsePropfind(await request.text());
    const depth = CalDavUtil.parseDepth(request.headers.get('Depth'));
    if (path.resource === 'root') return CalDavUtil.propfindRoot(application.applicationId, propfind);
    if (path.resource === 'principal') return CalDavUtil.propfindPrincipal(application.applicationId, propfind);

    const accessToken = await OAuth2AccessTokenService.getAccessToken(application.applicationId, env);
    if (path.resource === 'calendarHome') {
      const calendars = depth > 0 ? await CalendarProviderUtil.listCalendars(application.providerId, accessToken) : [];
      return CalDavUtil.propfindCalendarHome(application.applicationId, calendars, propfind, depth);
    }
    if (path.resource === 'calendar' && path.calendarId) {
      const calendar = await this.requireCalendar(application, accessToken, path.calendarId);
      const shouldFetchObjects = depth > 0 || this.propfindNeedsCalendarObjects(propfind);
      const events = shouldFetchObjects
        ? await CalendarProviderUtil.listEvents(application.providerId, accessToken, path.calendarId)
        : [];
      const synced = shouldFetchObjects
        ? await this.syncProviderSnapshot(mappingDAO, application.applicationId, path.calendarId, events)
        : { live: [], deleted: [] };
      const syncToken = CalDavUtil.syncToken(
        application.applicationId,
        path.calendarId,
        shouldFetchObjects ? await mappingDAO.getMaxSyncVersion(application.applicationId, path.calendarId) : 0,
      );
      return CalDavUtil.propfindCalendar(application.applicationId, calendar, propfind, depth, [...synced.live, ...synced.deleted], syncToken);
    }
    if (path.resource === 'object' && path.calendarId && path.objectHref) {
      const event = await this.getDavObject(
        application,
        accessToken,
        new CalendarObjectMappingDAO(env.DB),
        path.calendarId,
        path.objectHref,
      );
      return CalDavUtil.propfindObject(application.applicationId, path.calendarId, path.objectHref, event, propfind);
    }
    return CalDavUtil.notFound(new URL(request.url).pathname);
  }

  private async handleDavReport(
    request: Request,
    env: Env,
    application: ConnectedApplication,
    path: ReturnType<typeof CalDavUtil.parsePath>,
    mappingDAO: CalendarObjectMappingDAO,
  ): Promise<Response> {
    if (path.resource !== 'calendar' || !path.calendarId)
      throw new HttpError(405, 'CalDAV reports are only supported on calendar collections.');
    const report = CalDavUtil.parseReport(await request.text());
    if (report.type !== 'calendar-query' && report.type !== 'calendar-multiget' && report.type !== 'sync-collection') throw new HttpError(400, 'Unsupported CalDAV report.');

    const accessToken = await OAuth2AccessTokenService.getAccessToken(application.applicationId, env);

    if (report.type === 'calendar-query') {
      const events = await CalendarProviderUtil.listEvents(application.providerId, accessToken, path.calendarId, report.timeRange);
      const isFullSnapshot = !report.timeRange?.start && !report.timeRange?.end;
      const synced = isFullSnapshot
        ? await this.syncProviderSnapshot(mappingDAO, application.applicationId, path.calendarId, events)
        : { live: await this.upsertMappings(mappingDAO, application.applicationId, path.calendarId, events), deleted: [] };
      return CalDavUtil.calendarObjectReport(
        application.applicationId,
        path.calendarId,
        [...synced.live, ...synced.deleted],
        report.properties,
      );
    }

    if (report.type === 'sync-collection') {
      const events = await CalendarProviderUtil.listEvents(application.providerId, accessToken, path.calendarId);
      await this.syncProviderSnapshot(mappingDAO, application.applicationId, path.calendarId, events);
      const syncVersion = CalDavUtil.syncVersionFromToken(report.syncToken);
      const eventByProviderId = new Map(events.map((event) => [event.id || event.uid, event]));
      const changedMappings = await mappingDAO.listChangedSince(application.applicationId, path.calendarId, syncVersion);
      const results = this.mappingsToReportResults(changedMappings, eventByProviderId);
      const maxSyncVersion = await mappingDAO.getMaxSyncVersion(application.applicationId, path.calendarId);
      return CalDavUtil.syncCollectionReport(
        application.applicationId,
        path.calendarId,
        results,
        report.properties,
        CalDavUtil.syncToken(application.applicationId, path.calendarId, maxSyncVersion),
      );
    }

    const results: Array<{ href: string; event?: CalendarEvent | undefined; status?: number | undefined }> = [];
    for (const href of report.hrefs) {
      const objectHref = CalDavUtil.objectHrefFromDavHref(href, application.applicationId, path.calendarId);
      if (!objectHref) {
        results.push({ href, status: 404 });
        continue;
      }
      try {
        const event = await this.getDavObject(application, accessToken, mappingDAO, path.calendarId, objectHref);
        results.push({ href: objectHref, event });
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) results.push({ href: objectHref, status: 404 });
        else throw error;
      }
    }
    return CalDavUtil.calendarObjectReport(application.applicationId, path.calendarId, results, report.properties);
  }

  private async getDavObject(
    application: ConnectedApplication,
    accessToken: string,
    mappingDAO: CalendarObjectMappingDAO,
    calendarId: string,
    objectHref: string,
  ): Promise<CalendarEvent> {
    const mapping = await mappingDAO.getByHref(application.applicationId, calendarId, objectHref);
    if (mapping?.deletedAt) throw new HttpError(404, 'Calendar object was deleted.');
    const providerEventId = mapping?.providerEventId || CalDavUtil.providerEventIdFromObjectHref(objectHref);
    const event = await CalendarProviderUtil.getEvent(application.providerId, accessToken, calendarId, providerEventId);
    await mappingDAO.upsert(application.applicationId, calendarId, objectHref, event.id || providerEventId, event.uid, event.etag);
    return event;
  }

  private async requireCalendar(application: ConnectedApplication, accessToken: string, calendarId: string): Promise<ProviderCalendar> {
    const calendar = (await CalendarProviderUtil.listCalendars(application.providerId, accessToken)).find((item) => item.id === calendarId);
    if (!calendar) throw new HttpError(404, 'Calendar collection was not found.');
    return calendar;
  }

  private async requireWritableCalendar(application: ConnectedApplication, accessToken: string, calendarId: string): Promise<void> {
    const calendar = await this.requireCalendar(application, accessToken, calendarId);
    if (calendar.readOnly) throw new HttpError(403, 'Calendar collection is read-only.');
  }

  private async upsertMappings(
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

  private async syncProviderSnapshot(
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

  private mappingsToReportResults(
    mappings: CalendarObjectMapping[],
    eventByProviderId: Map<string, CalendarEvent>,
  ): Array<{ href: string; event?: CalendarEvent | undefined; status?: number | undefined; syncVersion?: number | undefined }> {
    return mappings.map((mapping) => {
      if (mapping.deletedAt) return { href: mapping.href, status: 404, syncVersion: mapping.syncVersion };
      const event = eventByProviderId.get(mapping.providerEventId);
      return event ? { href: mapping.href, event, syncVersion: mapping.syncVersion } : { href: mapping.href, status: 404, syncVersion: mapping.syncVersion };
    });
  }

  private propfindNeedsCalendarObjects(propfind: ReturnType<typeof CalDavUtil.parsePropfind>): boolean {
    return propfind.mode === 'allprop' || (propfind.mode === 'prop' && (propfind.properties.includes('getctag') || propfind.properties.includes('sync-token')));
  }

  private async authenticateDav(request: Request, env: Env, applicationId?: string | undefined): Promise<ConnectedApplication> {
    const authorization = request.headers.get('Authorization') || '';
    if (!authorization.startsWith('Basic ')) return unauthorizedDav();
    let decoded = '';
    try {
      decoded = atob(authorization.slice('Basic '.length));
    } catch {
      return unauthorizedDav();
    }
    const separatorIndex = decoded.indexOf(':');
    const username = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : '';
    const password = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : '';
    if (!username || !password) return unauthorizedDav();
    const credentialDAO = new CalDavCredentialDAO(env.DB);
    const credential = await credentialDAO.getByUsernameAndHash(username, await CalDavCredentialUtil.hashPassword(password), true);
    if (!credential || (applicationId && credential.applicationId !== applicationId)) return unauthorizedDav();
    await credentialDAO.updateLastUsed(credential.credentialId);
    const application = await (await this.applicationDAO(env)).getById(credential.applicationId);
    if (!application) return unauthorizedDav();
    return application;
  }

  private async requireUserApplicationFromQuery(request: Request, env: Env): Promise<ConnectedApplication> {
    const applicationId = new URL(request.url).searchParams.get('applicationId');
    if (!applicationId) throw new HttpError(400, 'applicationId is required.');
    return this.requireUserApplication(request, env, applicationId);
  }

  private async requireUserApplication(request: Request, env: Env, applicationId: string): Promise<ConnectedApplication> {
    const email = await this.requireUserEmail(request, env);
    const application = await (await this.applicationDAO(env)).getByIdForUser(applicationId, email);
    if (!application) throw new HttpError(404, 'Connected application was not found.');
    return application;
  }

  private async validatedBody<T>(request: Request): Promise<T> {
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const result = await validateRequestInput(request, body);
    if (!result.success) throw new HttpError(400, result.error);
    return result.data as T;
  }

  private async requireUserEmail(request: Request, env: Env): Promise<string> {
    const devEmail = (env as Env & { DEV_AUTH_EMAIL?: string }).DEV_AUTH_EMAIL;
    if (devEmail) return devEmail;

    const token = request.headers.get('cf-access-jwt-assertion');
    if (!token) throw new HttpError(401, 'No Cloudflare Access JWT token provided in request headers.');

    const envRecord = env as unknown as Record<string, unknown>;
    const teamDomain = envRecord.TEAM_DOMAIN as string | undefined;
    const policyAud = envRecord.POLICY_AUD as string | undefined;
    if (!teamDomain || !policyAud)
      throw new HttpError(401, 'Missing required JWT verification configuration (TEAM_DOMAIN or POLICY_AUD not set).');

    const normalizedTeamDomain = teamDomain.replace(/\/+$/, '');
    const normalizedPolicyAud = policyAud.trim();
    if (!normalizedPolicyAud) throw new HttpError(401, 'Missing required JWT verification configuration (empty POLICY_AUD).');
    if (normalizedPolicyAud.includes(','))
      throw new HttpError(401, 'Multiple JWT audiences are not supported. Configure a single POLICY_AUD value.');

    let email: string | undefined;
    try {
      const jwks = createRemoteJWKSet(new URL(`${normalizedTeamDomain}/cdn-cgi/access/certs`));
      const { payload } = await jwtVerify(token, jwks, {
        issuer: normalizedTeamDomain,
        audience: normalizedPolicyAud,
      });
      email = payload.email as string | undefined;
    } catch (error) {
      throw new HttpError(401, `JWT verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    if (!email) throw new HttpError(401, 'No email found in JWT token.');
    return email;
  }

  private async applicationDAO(env: Env): Promise<ConnectedApplicationDAO> {
    return new ConnectedApplicationDAO(env.DB, await env.AES_ENCRYPTION_KEY_SECRET.get());
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Error && /unique constraint/i.test(error.message);
  }

  private async decorateApplication(
    request: Request,
    application: ConnectedApplicationMetadata,
    credentialDAO: CalDavCredentialDAO,
  ): Promise<ConnectedApplicationMetadata> {
    return {
      ...application,
      oauth2RedirectUri: `${BaseUrlUtil.getBaseUrl(request)}/api/oauth2/callback/${application.applicationId}`,
      caldavBaseUrl: `${BaseUrlUtil.getBaseUrl(request)}/dav/calendars/${application.applicationId}/`,
      credentialCount: await credentialDAO.countByApplication(application.applicationId),
    };
  }
}

interface CreateApplicationInput {
  displayName: string;
  providerId: string;
  clientId: string;
  clientSecret: string;
}

function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, cf-access-jwt-assertion',
    'Access-Control-Max-Age': '86400',
  };
}

async function safe(action: () => Promise<Response>): Promise<Response> {
  try {
    return await action();
  } catch (error) {
    return errorResponse(error);
  }
}

async function safeDav(action: () => Promise<Response>): Promise<Response> {
  try {
    return await action();
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Internal server error.';
    if (status >= 500) console.error(error);
    return CalDavUtil.davError(status, message, error instanceof HttpError ? error.headers : undefined);
  }
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

function unauthorizedDav(): never {
  throw new HttpError(401, 'Valid CalDAV credentials are required.');
}

export { CalDavBridgeWorker };
