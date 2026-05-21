import { Hono } from 'hono';
import {
  CONNECTED_APPLICATION_STATUS_CONNECTED,
  DEFAULT_DEFAULT_CALDAV_CREDENTIAL_EXPIRY_DAYS,
  DEFAULT_MAX_APPLICATIONS_PER_USER,
  DEFAULT_MAX_CALDAV_CREDENTIALS_PER_APPLICATION,
  DEFAULT_MAX_CALDAV_CREDENTIAL_EXPIRY_DAYS,
  DEFAULT_OAUTH2_STATE_EXPIRY_MINUTES,
} from '@caldav-bridge/shared/constants';
import { CalDavCredentialUtil, TimestampUtil } from '@caldav-bridge/shared/utils';
import type { ConnectedApplication, ConnectedApplicationMetadata } from '@caldav-bridge/shared/model';
import { validateRequestInput } from '@caldav-bridge/shared/schema';
import { CalDavCredentialDAO, CalendarObjectMappingDAO, ConnectedApplicationDAO, OAuth2AuthorizationSessionDAO, UserDAO } from '@/dao';
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
    app.get('/api/oauth2/callback/:applicationId', async (c) => safe(() => this.oauth2Callback(c.req.raw, c.env, c.req.param('applicationId'))));

    app.all('/dav/*', async (c) => safe(() => this.handleDav(c.req.raw, c.env)));
    app.get('/user/*', (c) => (ConfigurationUtil.getServeSpaFromWorker(c.env) ? c.html(SPA_HTML) : c.notFound()));
    this.app = app;
  }

  public fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return Promise.resolve(this.app.fetch(request, env, ctx));
  }

  public scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    return Promise.resolve();
  }

  private async getCurrentUser(request: Request, env: Env): Promise<Response> {
    const email = await this.requireUserEmail(request, env);
    await new UserDAO(env.DB).ensure(email);
    return jsonResponse({
      email,
      limits: {
        maxApplicationsPerUser: ConfigurationUtil.getPositiveInteger(env.MAX_APPLICATIONS_PER_USER, DEFAULT_MAX_APPLICATIONS_PER_USER),
        maxCalDavCredentialsPerApplication: ConfigurationUtil.getPositiveInteger(env.MAX_CALDAV_CREDENTIALS_PER_APPLICATION, DEFAULT_MAX_CALDAV_CREDENTIALS_PER_APPLICATION),
        defaultCalDavCredentialExpiryDays: ConfigurationUtil.getPositiveInteger(env.DEFAULT_CALDAV_CREDENTIAL_EXPIRY_DAYS, DEFAULT_DEFAULT_CALDAV_CREDENTIAL_EXPIRY_DAYS),
      },
    });
  }

  private async listApplications(request: Request, env: Env): Promise<Response> {
    const email = await this.requireUserEmail(request, env);
    const applicationDAO = await this.applicationDAO(env);
    const credentialDAO = new CalDavCredentialDAO(env.DB);
    const applications = await Promise.all(
      (await applicationDAO.listMetadataByUserEmail(email)).map(async (application) => this.decorateApplication(request, application, credentialDAO)),
    );
    return jsonResponse({ applications });
  }

  private async createApplication(request: Request, env: Env): Promise<Response> {
    const body = await this.validatedBody<CreateApplicationInput>(request);
    const email = await this.requireUserEmail(request, env);
    await new UserDAO(env.DB).ensure(email);
    const applicationDAO = await this.applicationDAO(env);
    const maxApplications = ConfigurationUtil.getPositiveInteger(env.MAX_APPLICATIONS_PER_USER, DEFAULT_MAX_APPLICATIONS_PER_USER);
    if ((await applicationDAO.countByUserEmail(email)) >= maxApplications) throw new HttpError(400, `Maximum ${maxApplications} applications allowed per user.`);
    const application = await applicationDAO.create(email, body.displayName, body.providerId, { clientId: body.clientId, clientSecret: body.clientSecret });
    return jsonResponse({ application: await this.decorateApplication(request, application, new CalDavCredentialDAO(env.DB)) });
  }

  private async updateApplication(request: Request, env: Env): Promise<Response> {
    const body = await this.validatedBody<CreateApplicationInput & { applicationId: string }>(request);
    const email = await this.requireUserEmail(request, env);
    const applicationDAO = await this.applicationDAO(env);
    const application = await applicationDAO.updateForUser(body.applicationId, email, body.displayName, { clientId: body.clientId, clientSecret: body.clientSecret });
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
    const expiresAt = TimestampUtil.addMinutes(TimestampUtil.getCurrentUnixTimestampInSeconds(), ConfigurationUtil.getPositiveInteger(env.OAUTH2_STATE_EXPIRY_MINUTES, DEFAULT_OAUTH2_STATE_EXPIRY_MINUTES));
    await new OAuth2AuthorizationSessionDAO(env.DB).create(application.applicationId, await OAuth2StateUtil.getStateHash(state), codeVerifier, redirectUri, expiresAt);
    return jsonResponse({
      authorizationUrl: OAuth2ProviderUtil.buildAuthorizationUrl({ providerId: application.providerId, clientId: application.credentials.clientId, redirectUri, state, codeChallenge }),
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
    if (application.status !== CONNECTED_APPLICATION_STATUS_CONNECTED) throw new HttpError(400, 'Connect OAuth2 before creating CalDAV credentials.');
    const credentialDAO = new CalDavCredentialDAO(env.DB);
    const maxCredentials = ConfigurationUtil.getPositiveInteger(env.MAX_CALDAV_CREDENTIALS_PER_APPLICATION, DEFAULT_MAX_CALDAV_CREDENTIALS_PER_APPLICATION);
    if ((await credentialDAO.countByApplication(application.applicationId)) >= maxCredentials) throw new HttpError(400, `Maximum ${maxCredentials} CalDAV credentials allowed per application.`);
    const defaultDays = ConfigurationUtil.getPositiveInteger(env.DEFAULT_CALDAV_CREDENTIAL_EXPIRY_DAYS, DEFAULT_DEFAULT_CALDAV_CREDENTIAL_EXPIRY_DAYS);
    const maxDays = ConfigurationUtil.getPositiveInteger(env.MAX_CALDAV_CREDENTIAL_EXPIRY_DAYS, DEFAULT_MAX_CALDAV_CREDENTIAL_EXPIRY_DAYS);
    const expiresInDays = body.expiresInDays || defaultDays;
    if (expiresInDays > maxDays) throw new HttpError(400, `CalDAV credential expiry cannot exceed ${maxDays} days.`);
    const password = CalDavCredentialUtil.generatePassword();
    const metadata = await credentialDAO.create(application.applicationId, await CalDavCredentialUtil.hashPassword(password), body.name, CalDavCredentialUtil.getPrefix(password), CalDavCredentialUtil.getLastFour(password), TimestampUtil.addDays(TimestampUtil.getCurrentUnixTimestampInSeconds(), expiresInDays));
    return jsonResponse({ password, metadata });
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
    if (!path.applicationId) return CalDavUtil.principal(BaseUrlUtil.getBaseUrl(request), 'caldav-bridge');
    const application = await this.authenticateDav(request, env, path.applicationId);
    const accessToken = await OAuth2AccessTokenService.getAccessToken(application.applicationId, env);
    const mappingDAO = new CalendarObjectMappingDAO(env.DB);

    if (!path.calendarId) {
      const calendars = await CalendarProviderUtil.listCalendars(application.providerId, accessToken);
      return CalDavUtil.calendarHome(application.applicationId, calendars);
    }

    if (!path.objectHref) {
      const events = await CalendarProviderUtil.listEvents(application.providerId, accessToken, path.calendarId);
      await Promise.all(events.map((event) => mappingDAO.upsert(application.applicationId, path.calendarId || '', ICalendarUtil.eventHref(event), event.id || event.uid, event.uid, event.etag)));
      return CalDavUtil.calendarObjects(application.applicationId, path.calendarId, events);
    }

    const mapping = await mappingDAO.getByHref(application.applicationId, path.calendarId, path.objectHref);
    const providerEventId = mapping?.providerEventId || path.objectHref.replace(/\.ics$/i, '');
    if (request.method === 'GET' || request.method === 'REPORT' || request.method === 'PROPFIND') {
      const event = await CalendarProviderUtil.getEvent(application.providerId, accessToken, path.calendarId, providerEventId);
      if (request.method !== 'GET') return CalDavUtil.calendarObjects(application.applicationId, path.calendarId, [event]);
      return new Response(ICalendarUtil.toICS(event), { headers: { 'Content-Type': 'text/calendar; charset=utf-8', ETag: event.etag || event.uid } });
    }
    if (request.method === 'PUT') {
      const event = ICalendarUtil.fromICS(await request.text(), mapping?.uid || crypto.randomUUID());
      const saved = await CalendarProviderUtil.upsertEvent(application.providerId, accessToken, path.calendarId, event, mapping?.providerEventId);
      await mappingDAO.upsert(application.applicationId, path.calendarId, path.objectHref, saved.id || event.uid, saved.uid, saved.etag);
      return new Response(null, { status: mapping ? 204 : 201, headers: { ETag: saved.etag || saved.uid } });
    }
    if (request.method === 'DELETE') {
      await CalendarProviderUtil.deleteEvent(application.providerId, accessToken, path.calendarId, providerEventId);
      await mappingDAO.deleteByHref(application.applicationId, path.calendarId, path.objectHref);
      return new Response(null, { status: 204 });
    }
    throw new HttpError(405, 'Unsupported CalDAV method.');
  }

  private async authenticateDav(request: Request, env: Env, applicationId: string): Promise<ConnectedApplication> {
    const authorization = request.headers.get('Authorization') || '';
    if (!authorization.startsWith('Basic ')) return unauthorizedDav();
    const decoded = atob(authorization.slice('Basic '.length));
    const password = decoded.slice(decoded.indexOf(':') + 1);
    const credentialDAO = new CalDavCredentialDAO(env.DB);
    const credential = await credentialDAO.getByHash(await CalDavCredentialUtil.hashPassword(password), true);
    if (!credential || credential.applicationId !== applicationId) return unauthorizedDav();
    await credentialDAO.updateLastUsed(credential.credentialId);
    const application = await (await this.applicationDAO(env)).getById(applicationId);
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
    const email = devEmail || request.headers.get('Cf-Access-Authenticated-User-Email');
    if (!email) throw new HttpError(401, 'Cloudflare Access user email is required.');
    return email;
  }

  private async applicationDAO(env: Env): Promise<ConnectedApplicationDAO> {
    return new ConnectedApplicationDAO(env.DB, await env.AES_ENCRYPTION_KEY_SECRET.get());
  }

  private async decorateApplication(request: Request, application: ConnectedApplicationMetadata, credentialDAO: CalDavCredentialDAO): Promise<ConnectedApplicationMetadata> {
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

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

function unauthorizedDav(): never {
  throw new HttpError(401, 'Valid CalDAV credentials are required.');
}

export { CalDavBridgeWorker };
