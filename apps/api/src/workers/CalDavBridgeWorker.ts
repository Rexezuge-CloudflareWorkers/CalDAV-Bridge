import { Hono } from 'hono';
import { AbstractEntrypointWorker } from '@caldav-bridge/backend-runtime/base';
import { DURABLE_OBJECT_CRON_TASKS_RUN_URL, DURABLE_OBJECT_NAMESPACE_GLOBAL } from '@caldav-bridge/backend-runtime/constants';
import { ConfigurationManager } from '@caldav-bridge/backend-runtime/config';
import { createD1SessionEnv } from '@caldav-bridge/backend-data/utils';
import { CalDavCredentialDAO, CalendarObjectMappingDAO } from '@caldav-bridge/backend-data/dao';
import {
  BadRequestError,
  MethodNotAllowedError,
  PreconditionFailedError,
  RequestEntityTooLargeError,
  ServiceError,
  UnauthorizedError,
  UnsupportedMediaTypeError,
} from '@caldav-bridge/backend-errors';
import { ApplicationService } from '@caldav-bridge/backend-services/application';
import type { CreateApplicationInput } from '@caldav-bridge/backend-services/application';
import { CalDavUtil, CalendarService, ICalendarUtil } from '@caldav-bridge/backend-services/calendar';
import { CredentialService } from '@caldav-bridge/backend-services/credential';
import { OAuth2AuthorizationService } from '@caldav-bridge/backend-services/oauth2';
import { UserService } from '@caldav-bridge/backend-services/user';
import type { UserIdentity } from '@caldav-bridge/backend-services/user';
import { BaseUrlUtil, CalDavCredentialUtil } from '@caldav-bridge/shared/utils';
import { DAV_REQUEST_BODY_MAX_BYTES, DAV_RESOURCE_MAX_BYTES } from '@caldav-bridge/shared/constants';
import { validateRequestInput } from '@caldav-bridge/shared/schema';
import type { CalendarEvent, ConnectedApplication } from '@caldav-bridge/shared/model';
import { MiddlewareHandlers } from '@/middleware';
import { errorResponse, jsonResponse } from '@caldav-bridge/backend-runtime/http';
import { SPA_HTML } from '@/generated/spa-shell';

type AppBindings = Env;
type AppVariables = { AuthenticatedUser: UserIdentity };

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

    app.get('/user/me', async (c) => safe(() => this.getCurrentUser(c.get('AuthenticatedUser'), c.env)));
    app.get('/user/applications', async (c) => safe(() => this.listApplications(c.get('AuthenticatedUser').userId, c.req.raw, c.env)));
    app.post('/user/application', async (c) => safe(() => this.createApplication(c.get('AuthenticatedUser').userId, c.req.raw, c.env)));
    app.put('/user/application', async (c) => safe(() => this.updateApplication(c.get('AuthenticatedUser').userId, c.req.raw, c.env)));
    app.delete('/user/application', async (c) => safe(() => this.deleteApplication(c.get('AuthenticatedUser').userId, c.req.raw, c.env)));
    app.post('/user/application/oauth2/authorize', async (c) =>
      safe(() => this.createOAuth2Authorization(c.get('AuthenticatedUser').userId, c.req.raw, c.env)),
    );
    app.get('/user/application/calendars', async (c) =>
      safe(() => this.listCalendars(c.get('AuthenticatedUser').userId, c.req.raw, c.env)),
    );
    app.get('/user/application/caldav-credentials', async (c) =>
      safe(() => this.listCalDavCredentials(c.get('AuthenticatedUser').userId, c.req.raw, c.env)),
    );
    app.post('/user/application/caldav-credential', async (c) =>
      safe(() => this.createCalDavCredential(c.get('AuthenticatedUser').userId, c.req.raw, c.env)),
    );
    app.delete('/user/application/caldav-credential', async (c) =>
      safe(() => this.deleteCalDavCredential(c.get('AuthenticatedUser').userId, c.req.raw, c.env)),
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
          if (!response.ok && response.status !== 202)
            console.error('CronTasksWorker returned an error response:', response.status, await response.text());
        })
        .catch((error: unknown) => {
          console.error('Failed to invoke CronTasksWorker:', error);
        }),
    );
  }

  /**
   * Reported from the resolved account rather than from the request, so an
   * address that has since been changed shows up here immediately instead of
   * echoing the address the caller happens to present.
   */
  private async getCurrentUser(identity: UserIdentity, env: Env): Promise<Response> {
    return jsonResponse(await new UserService(env).getCurrentUser(identity));
  }

  private async listApplications(userId: string, request: Request, env: Env): Promise<Response> {
    const applications = await new ApplicationService(env).listApplications(userId, BaseUrlUtil.getBaseUrl(request));
    return jsonResponse({ applications });
  }

  private async createApplication(userId: string, request: Request, env: Env): Promise<Response> {
    const body = await this.validatedBody<CreateApplicationInput>(request);
    const application = await new ApplicationService(env).createApplication(userId, body, BaseUrlUtil.getBaseUrl(request));
    return jsonResponse({ application });
  }

  private async updateApplication(userId: string, request: Request, env: Env): Promise<Response> {
    const body = await this.validatedBody<CreateApplicationInput & { applicationId: string }>(request);
    const application = await new ApplicationService(env).updateApplication(
      userId,
      body.applicationId,
      body,
      BaseUrlUtil.getBaseUrl(request),
    );
    return jsonResponse({ application });
  }

  private async deleteApplication(userId: string, request: Request, env: Env): Promise<Response> {
    const body = await this.validatedBody<{ applicationId: string }>(request);
    await new ApplicationService(env).deleteApplication(userId, body.applicationId);
    return jsonResponse({ success: true });
  }

  private async createOAuth2Authorization(userId: string, request: Request, env: Env): Promise<Response> {
    const body = await this.validatedBody<{ applicationId: string }>(request);
    const service = new ApplicationService(env);
    const application = await service.requireUserApplication(userId, body.applicationId);
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

  private async listCalendars(userId: string, request: Request, env: Env): Promise<Response> {
    const application = await this.requireUserApplicationFromQuery(userId, request, env);
    return jsonResponse({ calendars: await new CalendarService(env).listCalendars(application) });
  }

  private async listCalDavCredentials(userId: string, request: Request, env: Env): Promise<Response> {
    const application = await this.requireUserApplicationFromQuery(userId, request, env);
    return jsonResponse({ credentials: await new CredentialService(env).listCredentials(application.applicationId) });
  }

  private async createCalDavCredential(userId: string, request: Request, env: Env): Promise<Response> {
    const body = await this.validatedBody<{ applicationId: string; name: string; expiresInDays?: number }>(request);
    const application = await this.requireUserApplication(userId, env, body.applicationId);
    return jsonResponse(await new CredentialService(env).createCredential(application, body.name, body.expiresInDays));
  }

  private async deleteCalDavCredential(userId: string, request: Request, env: Env): Promise<Response> {
    const body = await this.validatedBody<{ applicationId: string; credentialId: string }>(request);
    const application = await this.requireUserApplication(userId, env, body.applicationId);
    await new CredentialService(env).deleteCredential(application.applicationId, body.credentialId);
    return jsonResponse({ success: true });
  }

  private async handleDav(request: Request, env: Env): Promise<Response> {
    const calendarService = new CalendarService(env);
    if (request.method === 'OPTIONS') return CalDavUtil.options();
    // Size is checked before authentication on purpose: an oversized body is
    // refused on its own merits, so an unauthenticated caller cannot make this
    // server buffer one.
    // Read once, up front: a `Request` body is single-use, and the size is
    // checked before the text is handed to any parser or provider.
    const body = DAV_BODY_METHODS.has(request.method) ? await readDavBody(request, davBodyLimit(request.method)) : '';
    const url = new URL(request.url);
    const path = CalDavUtil.parsePath(url.pathname);
    if (path.resource === 'invalid') throw new BadRequestError('Malformed CalDAV request path.');
    if (path.resource === 'unknown') return CalDavUtil.notFound(url.pathname);
    const application = await this.authenticateDav(request, env, path.applicationId);
    const mappingDAO = new CalendarObjectMappingDAO(env.DB);

    if (request.method === 'PROPFIND') return this.handleDavPropfind(body, request, calendarService, application, path, mappingDAO);
    if (request.method === 'REPORT') return this.handleDavReport(body, request, calendarService, application, path, mappingDAO);

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
      // RFC 4918 §9.7.1. Clients that send no Content-Type are common enough to
      // accept, but one that names a different type is telling us it is not
      // sending a calendar object, and the body is about to become a real event.
      const contentType = request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
      if (contentType && contentType !== 'text/calendar')
        throw new UnsupportedMediaTypeError(`Unsupported media type: ${contentType}.`);
      const mapping = await mappingDAO.getByHref(application.applicationId, path.calendarId, path.objectHref);
      const liveMapping = mapping?.deletedAt ? undefined : mapping;
      if (request.headers.get('If-None-Match')?.trim() === '*' && liveMapping)
        throw new PreconditionFailedError('Calendar object already exists.');
      if (!CalDavUtil.etagMatches(request.headers.get('If-Match'), liveMapping?.etag || undefined))
        throw new PreconditionFailedError('Calendar object ETag does not match.');
      // `fromICS` throws on anything that is not a single well-formed VEVENT, so
      // a malformed body is rejected before it can reach the provider calendar.
      const event = ICalendarUtil.fromICS(body, liveMapping?.uid || crypto.randomUUID());
      const saved = await calendarService.upsertEvent(application, accessToken, path.calendarId, event, liveMapping?.providerEventId);
      await mappingDAO.upsert(application.applicationId, path.calendarId, path.objectHref, saved.id || event.uid, saved.uid, saved.etag);
      return new Response(null, {
        status: liveMapping ? 204 : 201,
        headers: { ETag: CalDavUtil.eventEtag(saved), Location: url.pathname },
      });
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
    body: string,
    request: Request,
    calendarService: CalendarService,
    application: ConnectedApplication,
    path: ReturnType<typeof CalDavUtil.parsePath>,
    mappingDAO: CalendarObjectMappingDAO,
  ): Promise<Response> {
    const propfind = CalDavUtil.parsePropfind(body);
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
      const events = shouldFetchObjects ? await calendarService.listEvents(application, accessToken, path.calendarId) : [];
      // The token must be the state the objects below were read at. Taking it
      // from the sync itself keeps the two in agreement, where a second read
      // could hand back a version newer than the objects just serialised.
      const synced = shouldFetchObjects
        ? await calendarService.syncProviderSnapshot(mappingDAO, application.applicationId, path.calendarId, events)
        : { live: [], deleted: [], syncVersion: await mappingDAO.getMaxSyncVersion(application.applicationId, path.calendarId) };
      const syncToken = CalDavUtil.syncToken(application.applicationId, path.calendarId, synced.syncVersion);
      return CalDavUtil.propfindCalendar(
        application.applicationId,
        calendar,
        propfind,
        depth,
        [...synced.live, ...synced.deleted],
        syncToken,
      );
    }
    if (path.resource === 'object' && path.calendarId && path.objectHref) {
      const event = await calendarService.getDavObject(application, accessToken, mappingDAO, path.calendarId, path.objectHref);
      return CalDavUtil.propfindObject(application.applicationId, path.calendarId, path.objectHref, event, propfind);
    }
    return CalDavUtil.notFound(new URL(request.url).pathname);
  }

  private async handleDavReport(
    body: string,
    request: Request,
    calendarService: CalendarService,
    application: ConnectedApplication,
    path: ReturnType<typeof CalDavUtil.parsePath>,
    mappingDAO: CalendarObjectMappingDAO,
  ): Promise<Response> {
    if (path.resource !== 'calendar' || !path.calendarId)
      throw new MethodNotAllowedError('CalDAV reports are only supported on calendar collections.');
    const report = CalDavUtil.parseReport(body);
    if (report.type !== 'calendar-query' && report.type !== 'calendar-multiget' && report.type !== 'sync-collection')
      throw new BadRequestError('Unsupported CalDAV report.');

    const accessToken = await calendarService.getAccessToken(application.applicationId);

    if (report.type === 'calendar-query') {
      const events = await calendarService.listEvents(application, accessToken, path.calendarId, report.timeRange);
      const isFullSnapshot = !report.timeRange?.start && !report.timeRange?.end;
      // A time-ranged query returns a subset, so treating what is absent from
      // it as deleted would tombstone the whole rest of the calendar. Only a
      // full snapshot is allowed to conclude anything from an absence.
      const synced = isFullSnapshot
        ? await calendarService.syncProviderSnapshot(mappingDAO, application.applicationId, path.calendarId, events)
        : {
            live: events.map((event) => ({ href: ICalendarUtil.eventHref(event), event })),
            deleted: [],
          };
      return CalDavUtil.calendarObjectReport(
        application.applicationId,
        path.calendarId,
        [...synced.live, ...synced.deleted],
        report.properties,
      );
    }

    if (report.type === 'sync-collection') {
      const syncVersion = CalDavUtil.syncVersionFromToken(report.syncToken);
      const events = await calendarService.listEvents(application, accessToken, path.calendarId);
      const synced = await calendarService.syncProviderSnapshot(mappingDAO, application.applicationId, path.calendarId, events);
      // Capture the ceiling, then report exactly the window that was captured.
      // Selecting "everything since the client's token" and reading the maximum
      // afterwards would report a window that had already closed: a write
      // landing in between carries a version at or below the returned token
      // while being absent from the results, and the next request asks for
      // `> token`, so the client is never sent that object again.
      const through = Math.max(synced.syncVersion, syncVersion);
      const changedMappings = await mappingDAO.listChangedBetween(application.applicationId, path.calendarId, syncVersion, through);
      const eventByProviderId = new Map(events.map((event) => [event.id || event.uid, event]));
      const results = calendarService.mappingsToReportResults(changedMappings, eventByProviderId);
      return CalDavUtil.syncCollectionReport(
        application.applicationId,
        path.calendarId,
        results,
        report.properties,
        CalDavUtil.syncToken(application.applicationId, path.calendarId, through),
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
    return (
      propfind.mode === 'allprop' ||
      (propfind.mode === 'prop' && (propfind.properties.includes('getctag') || propfind.properties.includes('sync-token')))
    );
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

  private async requireUserApplicationFromQuery(userId: string, request: Request, env: Env): Promise<ConnectedApplication> {
    const applicationId = new URL(request.url).searchParams.get('applicationId');
    if (!applicationId) throw new BadRequestError('applicationId is required.');
    return this.requireUserApplication(userId, env, applicationId);
  }

  private async requireUserApplication(userId: string, env: Env, applicationId: string): Promise<ConnectedApplication> {
    return new ApplicationService(env).requireUserApplication(userId, applicationId);
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
    if (status >= 500) {
      // Internal failures routinely carry schema, table and provider detail in
      // their message. It is logged rather than returned: the client needs to
      // know the request failed, not how the store is laid out.
      console.error(error);
      return CalDavUtil.davError(status, 'The server encountered an internal error.', error instanceof ServiceError ? error.headers : undefined);
    }
    const message = error instanceof Error ? error.message : 'Internal server error.';
    return CalDavUtil.davError(status, message, error instanceof ServiceError ? error.headers : undefined);
  }
}

/** DAV methods that carry a request body worth bounding. */
const DAV_BODY_METHODS: ReadonlySet<string> = new Set(['PROPFIND', 'REPORT', 'PUT']);

function davBodyLimit(method: string): number {
  return method === 'PUT' ? DAV_RESOURCE_MAX_BYTES : DAV_REQUEST_BODY_MAX_BYTES;
}

/**
 * Refuse an oversized DAV body before it is buffered, parsed or forwarded.
 *
 * `Content-Length` is checked first so a large upload is rejected on its
 * declared size alone. The body is then read and measured again, because that
 * header is client-supplied: it may be absent, or simply wrong, and it is the
 * byte count of what actually arrived that matters.
 */
async function readDavBody(request: Request, maxBytes: number): Promise<string> {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new RequestEntityTooLargeError();
  const body = await request.text();
  if (new TextEncoder().encode(body).length > maxBytes) throw new RequestEntityTooLargeError();
  return body;
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

function unauthorizedDav(): never {
  throw new UnauthorizedError('Valid CalDAV credentials are required.');
}

export { CalDavBridgeWorker };
