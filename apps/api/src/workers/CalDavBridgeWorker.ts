import { Hono } from 'hono';
import { AbstractEntrypointWorker } from '@caldav-bridge/backend-runtime/base';
import { DURABLE_OBJECT_CRON_TASKS_RUN_URL, DURABLE_OBJECT_NAMESPACE_GLOBAL } from '@caldav-bridge/backend-runtime/constants';
import { ConfigurationManager } from '@caldav-bridge/backend-runtime/config';
import { createD1SessionEnv } from '@caldav-bridge/backend-data/utils';
import { CalDavCredentialDAO, CalendarObjectMappingDAO } from '@caldav-bridge/backend-data/dao';
import { BadRequestError, MethodNotAllowedError, PreconditionFailedError, ServiceError, UnauthorizedError } from '@caldav-bridge/backend-errors';
import { ApplicationService } from '@caldav-bridge/backend-services/application';
import type { CreateApplicationInput } from '@caldav-bridge/backend-services/application';
import { CalDavUtil, CalendarService, ICalendarUtil } from '@caldav-bridge/backend-services/calendar';
import { CredentialService } from '@caldav-bridge/backend-services/credential';
import { OAuth2AuthorizationService } from '@caldav-bridge/backend-services/oauth2';
import { UserService } from '@caldav-bridge/backend-services/user';
import { BaseUrlUtil, CalDavCredentialUtil } from '@caldav-bridge/shared/utils';
import { validateRequestInput } from '@caldav-bridge/shared/schema';
import type { CalendarEvent, ConnectedApplication } from '@caldav-bridge/shared/model';
import { MiddlewareHandlers } from '@/middleware';
import { errorResponse, jsonResponse } from '@caldav-bridge/backend-runtime/http';
import { SPA_HTML } from '@/generated/spa-shell';

type AppBindings = Env;
type AppVariables = { AuthenticatedUserEmailAddress: string };

const D1_BOOKMARK_HEADER: string = 'x-d1-bookmark';

class CalDavBridgeWorker extends AbstractEntrypointWorker {
  private readonly app: Hono<{ Bindings: AppBindings; Variables: AppVariables }>;

  constructor() {
    super();
    const app = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();
    app.get('/', (c) => c.redirect('/user/'));
    app.get('/.well-known/caldav', (c) => c.redirect('/dav/', 301));
    app.options('/user/*', () => new Response(null, { status: 204, headers: corsHeaders() }));

    app.use('/user/*', MiddlewareHandlers.userAuthentication());

    app.get('/user/me', async (c) => safe(() => this.getCurrentUser(c.get('AuthenticatedUserEmailAddress'), c.env)));
    app.get('/user/applications', async (c) => safe(() => this.listApplications(c.get('AuthenticatedUserEmailAddress'), c.req.raw, c.env)));
    app.post('/user/application', async (c) => safe(() => this.createApplication(c.get('AuthenticatedUserEmailAddress'), c.req.raw, c.env)));
    app.put('/user/application', async (c) => safe(() => this.updateApplication(c.get('AuthenticatedUserEmailAddress'), c.req.raw, c.env)));
    app.delete('/user/application', async (c) => safe(() => this.deleteApplication(c.get('AuthenticatedUserEmailAddress'), c.req.raw, c.env)));
    app.post('/user/application/oauth2/authorize', async (c) =>
      safe(() => this.createOAuth2Authorization(c.get('AuthenticatedUserEmailAddress'), c.req.raw, c.env)),
    );
    app.get('/user/application/calendars', async (c) => safe(() => this.listCalendars(c.get('AuthenticatedUserEmailAddress'), c.req.raw, c.env)));
    app.get('/user/application/caldav-credentials', async (c) =>
      safe(() => this.listCalDavCredentials(c.get('AuthenticatedUserEmailAddress'), c.req.raw, c.env)),
    );
    app.post('/user/application/caldav-credential', async (c) =>
      safe(() => this.createCalDavCredential(c.get('AuthenticatedUserEmailAddress'), c.req.raw, c.env)),
    );
    app.delete('/user/application/caldav-credential', async (c) =>
      safe(() => this.deleteCalDavCredential(c.get('AuthenticatedUserEmailAddress'), c.req.raw, c.env)),
    );
    app.get('/api/oauth2/callback/:applicationId', async (c) =>
      safe(() => this.oauth2Callback(c.req.raw, c.env, c.req.param('applicationId'))),
    );

    app.all('/dav', async (c) => safeDav(() => this.handleDav(c.req.raw, c.env)));
    app.all('/dav/*', async (c) => safeDav(() => this.handleDav(c.req.raw, c.env)));
    app.get('/user/*', (c) => (ConfigurationManager.getServeSpaFromWorker(c.env) ? c.html(SPA_HTML) : c.notFound()));
    this.app = app;
  }

  protected async onRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path: string = new URL(request.url).pathname;
    if (!CalDavBridgeWorker.shouldUseD1Session(path, env)) {
      return this.app.fetch(request, env, ctx);
    }

    const isUserRequest: boolean = path.startsWith('/user/');
    const incomingBookmark: string | undefined = isUserRequest ? request.headers.get(D1_BOOKMARK_HEADER)?.trim() || undefined : undefined;
    const sessionEnv = createD1SessionEnv(env, incomingBookmark || 'first-primary');
    const response: Response = await this.app.fetch(request, sessionEnv, ctx);
    if (isUserRequest) {
      const bookmark: D1SessionBookmark | null = sessionEnv.DB.getBookmark();
      if (bookmark) {
        response.headers.set(D1_BOOKMARK_HEADER, bookmark);
      }
      response.headers.set('Access-Control-Expose-Headers', D1_BOOKMARK_HEADER);
    }
    return response;
  }

  protected async onScheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cronTasksId = env.CRON_TASKS.idFromName(DURABLE_OBJECT_NAMESPACE_GLOBAL);
    const cronTasksStub = env.CRON_TASKS.get(cronTasksId);
    const cronTasksRequest = new Request(DURABLE_OBJECT_CRON_TASKS_RUN_URL, {
      method: 'POST',
      body: JSON.stringify({ cron: event.cron, scheduledTime: event.scheduledTime }),
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
  }

  private async getCurrentUser(email: string, env: Env): Promise<Response> {
    const limits = await new UserService(env).getCurrentUserLimits();
    return jsonResponse({ email, limits });
  }

  private async listApplications(email: string, request: Request, env: Env): Promise<Response> {
    const applications = await new ApplicationService(env).listApplications(email, BaseUrlUtil.getBaseUrl(request));
    return jsonResponse({ applications });
  }

  private async createApplication(email: string, request: Request, env: Env): Promise<Response> {
    const body = await this.validatedBody<CreateApplicationInput>(request);
    const application = await new ApplicationService(env).createApplication(email, body, BaseUrlUtil.getBaseUrl(request));
    return jsonResponse({ application });
  }

  private async updateApplication(email: string, request: Request, env: Env): Promise<Response> {
    const body = await this.validatedBody<CreateApplicationInput & { applicationId: string }>(request);
    const application = await new ApplicationService(env).updateApplication(email, body.applicationId, body, BaseUrlUtil.getBaseUrl(request));
    return jsonResponse({ application });
  }

  private async deleteApplication(email: string, request: Request, env: Env): Promise<Response> {
    const body = await this.validatedBody<{ applicationId: string }>(request);
    await new ApplicationService(env).deleteApplication(email, body.applicationId);
    return jsonResponse({ success: true });
  }

  private async createOAuth2Authorization(email: string, request: Request, env: Env): Promise<Response> {
    const body = await this.validatedBody<{ applicationId: string }>(request);
    const service = new ApplicationService(env);
    const application = await service.requireUserApplication(email, body.applicationId);
    return jsonResponse(await new OAuth2AuthorizationService(env).createAuthorization(application, BaseUrlUtil.getBaseUrl(request)));
  }

  private async oauth2Callback(request: Request, env: Env, applicationId?: string): Promise<Response> {
    if (!applicationId) throw new BadRequestError('OAuth2 callback is missing applicationId.');
    const url = new URL(request.url);
    const result = await new OAuth2AuthorizationService(env).completeCallback(
      applicationId,
      url.searchParams.get('code'),
      url.searchParams.get('state'),
      url.searchParams.get('error'),
    );
    return redirect(result.redirect);
  }

  private async listCalendars(email: string, request: Request, env: Env): Promise<Response> {
    const application = await this.requireUserApplicationFromQuery(email, request, env);
    return jsonResponse({ calendars: await new CalendarService(env).listCalendars(application) });
  }

  private async listCalDavCredentials(email: string, request: Request, env: Env): Promise<Response> {
    const application = await this.requireUserApplicationFromQuery(email, request, env);
    return jsonResponse({ credentials: await new CredentialService(env).listCredentials(application.applicationId) });
  }

  private async createCalDavCredential(email: string, request: Request, env: Env): Promise<Response> {
    const body = await this.validatedBody<{ applicationId: string; name: string; expiresInDays?: number }>(request);
    const application = await this.requireUserApplication(email, env, body.applicationId);
    return jsonResponse(await new CredentialService(env).createCredential(application, body.name, body.expiresInDays));
  }

  private async deleteCalDavCredential(email: string, request: Request, env: Env): Promise<Response> {
    const body = await this.validatedBody<{ applicationId: string; credentialId: string }>(request);
    const application = await this.requireUserApplication(email, env, body.applicationId);
    await new CredentialService(env).deleteCredential(application.applicationId, body.credentialId);
    return jsonResponse({ success: true });
  }

  private async handleDav(request: Request, env: Env): Promise<Response> {
    const calendarService = new CalendarService(env);
    if (request.method === 'OPTIONS') return CalDavUtil.options();
    const url = new URL(request.url);
    const path = CalDavUtil.parsePath(url.pathname);
    if (path.resource === 'unknown') return CalDavUtil.notFound(url.pathname);
    const application = await this.authenticateDav(request, env, path.applicationId);
    const mappingDAO = new CalendarObjectMappingDAO(env.DB);

    if (request.method === 'PROPFIND') return this.handleDavPropfind(request, env, calendarService, application, path, mappingDAO);
    if (request.method === 'REPORT') return this.handleDavReport(request, env, calendarService, application, path, mappingDAO);

    if (path.resource !== 'object' || !path.calendarId || !path.objectHref)
      throw new MethodNotAllowedError('Unsupported CalDAV method for this resource.');

    const accessToken = await calendarService.getAccessToken(application.applicationId);
    if (request.method === 'GET' || request.method === 'HEAD') {
      const event = await calendarService.getDavObject(application, accessToken, mappingDAO, path.calendarId, path.objectHref);
      if (request.method === 'HEAD') return CalDavUtil.headCalendarResponse(event);
      return CalDavUtil.textCalendarResponse(ICalendarUtil.toICS(event), event.etag || event.uid);
    }

    if (request.method === 'PUT') {
      await calendarService.requireWritableCalendar(application, accessToken, path.calendarId);
      const mapping = await mappingDAO.getByHref(application.applicationId, path.calendarId, path.objectHref);
      const liveMapping = mapping?.deletedAt ? undefined : mapping;
      if (request.headers.get('If-None-Match')?.trim() === '*' && liveMapping) throw new PreconditionFailedError('Calendar object already exists.');
      if (!CalDavUtil.etagMatches(request.headers.get('If-Match'), liveMapping?.etag || undefined))
        throw new PreconditionFailedError('Calendar object ETag does not match.');
      const event = ICalendarUtil.fromICS(await request.text(), liveMapping?.uid || crypto.randomUUID());
      const saved = await calendarService.upsertEvent(application, accessToken, path.calendarId, event, liveMapping?.providerEventId);
      await mappingDAO.upsert(application.applicationId, path.calendarId, path.objectHref, saved.id || event.uid, saved.uid, saved.etag);
      return new Response(null, { status: liveMapping ? 204 : 201, headers: { ETag: CalDavUtil.eventEtag(saved), Location: url.pathname } });
    }
    if (request.method === 'DELETE') {
      await calendarService.requireWritableCalendar(application, accessToken, path.calendarId);
      const mapping = await mappingDAO.getByHref(application.applicationId, path.calendarId, path.objectHref);
      if (!CalDavUtil.etagMatches(request.headers.get('If-Match'), mapping?.etag || undefined))
        throw new PreconditionFailedError('Calendar object ETag does not match.');
      const providerEventId = mapping?.providerEventId || CalDavUtil.providerEventIdFromObjectHref(path.objectHref);
      await calendarService.deleteEvent(application, accessToken, path.calendarId, providerEventId);
      await mappingDAO.markDeletedByHref(application.applicationId, path.calendarId, path.objectHref);
      return new Response(null, { status: 204 });
    }
    throw new MethodNotAllowedError('Unsupported CalDAV method.');
  }

  private async handleDavPropfind(
    request: Request,
    env: Env,
    calendarService: CalendarService,
    application: ConnectedApplication,
    path: ReturnType<typeof CalDavUtil.parsePath>,
    mappingDAO: CalendarObjectMappingDAO,
  ): Promise<Response> {
    const propfind = CalDavUtil.parsePropfind(await request.text());
    const depth = CalDavUtil.parseDepth(request.headers.get('Depth'));
    if (path.resource === 'root') return CalDavUtil.propfindRoot(application.applicationId, propfind);
    if (path.resource === 'principal') return CalDavUtil.propfindPrincipal(application.applicationId, propfind);

    const accessToken = await calendarService.getAccessToken(application.applicationId);
    if (path.resource === 'calendarHome') {
      const calendars = depth > 0 ? await calendarService.listCalendars(application) : [];
      return CalDavUtil.propfindCalendarHome(application.applicationId, calendars, propfind, depth);
    }
    if (path.resource === 'calendar' && path.calendarId) {
      const calendar = await calendarService.requireCalendar(application, accessToken, path.calendarId);
      const shouldFetchObjects = depth > 0 || this.propfindNeedsCalendarObjects(propfind);
      const events = shouldFetchObjects
        ? await calendarService.listEvents(application, accessToken, path.calendarId)
        : [];
      const synced = shouldFetchObjects
        ? await calendarService.syncProviderSnapshot(mappingDAO, application.applicationId, path.calendarId, events)
        : { live: [], deleted: [] };
      const syncToken = CalDavUtil.syncToken(
        application.applicationId,
        path.calendarId,
        shouldFetchObjects ? await mappingDAO.getMaxSyncVersion(application.applicationId, path.calendarId) : 0,
      );
      return CalDavUtil.propfindCalendar(application.applicationId, calendar, propfind, depth, [...synced.live, ...synced.deleted], syncToken);
    }
    if (path.resource === 'object' && path.calendarId && path.objectHref) {
      const event = await calendarService.getDavObject(
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
    calendarService: CalendarService,
    application: ConnectedApplication,
    path: ReturnType<typeof CalDavUtil.parsePath>,
    mappingDAO: CalendarObjectMappingDAO,
  ): Promise<Response> {
    if (path.resource !== 'calendar' || !path.calendarId)
      throw new MethodNotAllowedError('CalDAV reports are only supported on calendar collections.');
    const report = CalDavUtil.parseReport(await request.text());
    if (report.type !== 'calendar-query' && report.type !== 'calendar-multiget' && report.type !== 'sync-collection')
      throw new BadRequestError('Unsupported CalDAV report.');

    const accessToken = await calendarService.getAccessToken(application.applicationId);

    if (report.type === 'calendar-query') {
      const events = await calendarService.listEvents(application, accessToken, path.calendarId, report.timeRange);
      const isFullSnapshot = !report.timeRange?.start && !report.timeRange?.end;
      const synced = isFullSnapshot
        ? await calendarService.syncProviderSnapshot(mappingDAO, application.applicationId, path.calendarId, events)
        : { live: await calendarService.upsertMappings(mappingDAO, application.applicationId, path.calendarId, events), deleted: [] };
      return CalDavUtil.calendarObjectReport(
        application.applicationId,
        path.calendarId,
        [...synced.live, ...synced.deleted],
        report.properties,
      );
    }

    if (report.type === 'sync-collection') {
      const events = await calendarService.listEvents(application, accessToken, path.calendarId);
      await calendarService.syncProviderSnapshot(mappingDAO, application.applicationId, path.calendarId, events);
      const syncVersion = CalDavUtil.syncVersionFromToken(report.syncToken);
      const eventByProviderId = new Map(events.map((event) => [event.id || event.uid, event]));
      const changedMappings = await mappingDAO.listChangedSince(application.applicationId, path.calendarId, syncVersion);
      const results = calendarService.mappingsToReportResults(changedMappings, eventByProviderId);
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
        const event = await calendarService.getDavObject(application, accessToken, mappingDAO, path.calendarId, objectHref);
        results.push({ href: objectHref, event });
      } catch (error) {
        if (error instanceof ServiceError && error.getErrorCode() === 404) results.push({ href: objectHref, status: 404 });
        else throw error;
      }
    }
    return CalDavUtil.calendarObjectReport(application.applicationId, path.calendarId, results, report.properties);
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
    const application = await new ApplicationService(env).getApplicationById(credential.applicationId);
    if (!application) return unauthorizedDav();
    return application;
  }

  private async requireUserApplicationFromQuery(email: string, request: Request, env: Env): Promise<ConnectedApplication> {
    const applicationId = new URL(request.url).searchParams.get('applicationId');
    if (!applicationId) throw new BadRequestError('applicationId is required.');
    return this.requireUserApplication(email, env, applicationId);
  }

  private async requireUserApplication(email: string, env: Env, applicationId: string): Promise<ConnectedApplication> {
    return new ApplicationService(env).requireUserApplication(email, applicationId);
  }

  private async validatedBody<T>(request: Request): Promise<T> {
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const result = await validateRequestInput(request, body);
    if (!result.success) throw new BadRequestError(result.error);
    return result.data as T;
  }
  private static shouldUseD1Session(path: string, env: Env): boolean {
    if (!path.startsWith('/user/') && !path.startsWith('/api/')) {
      return false;
    }
    const database = (env as { DB?: { withSession?: unknown } }).DB;
    return typeof database?.withSession === 'function';
  }
}

function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': `Content-Type, Authorization, cf-access-jwt-assertion, ${D1_BOOKMARK_HEADER}`,
    'Access-Control-Expose-Headers': D1_BOOKMARK_HEADER,
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
    const status = error instanceof ServiceError ? error.getErrorCode() : 500;
    const message = error instanceof Error ? error.message : 'Internal server error.';
    if (status >= 500) console.error(error);
    return CalDavUtil.davError(status, message, error instanceof ServiceError ? error.headers : undefined);
  }
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

function unauthorizedDav(): never {
  throw new UnauthorizedError('Valid CalDAV credentials are required.');
}

export { CalDavBridgeWorker };
