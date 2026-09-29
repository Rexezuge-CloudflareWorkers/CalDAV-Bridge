import { CalendarObjectMappingDAO } from '@caldav-bridge/backend-data/dao';
import { RequestEntityTooLargeError } from '@caldav-bridge/backend-errors';
import { CalendarService } from '@caldav-bridge/backend-services/calendar';
import type { DavPath } from '@caldav-bridge/backend-services/calendar';
import { DAV_REQUEST_BODY_MAX_BYTES, DAV_RESOURCE_MAX_BYTES } from '@caldav-bridge/shared/constants';
import type { ConnectedApplication } from '@caldav-bridge/shared/model';

/**
 * Everything a DAV handler needs, resolved once per request.
 *
 * The handlers used to take the request, the environment, the service, the
 * application, the parsed path and the DAO as six separate parameters -- and one
 * of them, `env`, was never read. Threading this through instead of listing what
 * is available keeps a handler's dependencies visible in one place, and makes the
 * point at which authentication and authorization have already happened
 * explicit: nothing below `resolve` can be reached by an unauthenticated caller.
 */
class DavRequestContext {
  private accessTokenPromise?: Promise<string>;

  private constructor(
    readonly env: Env,
    readonly request: Request,
    /** The request body, already size-checked. Empty for methods that carry none. */
    readonly body: string,
    readonly path: DavPath,
    /** The application the presented credential is bound to. */
    readonly application: ConnectedApplication,
    readonly calendarService: CalendarService,
    readonly mappingDAO: CalendarObjectMappingDAO,
  ) {}

  /**
   * Build the context for an already-authenticated request.
   *
   * `body` is passed in rather than read here: a `Request` body is single-use,
   * so it is read and size-checked once during routing and then carried.
   */
  public static resolve(request: Request, env: Env, application: ConnectedApplication, path: DavPath, body: string): DavRequestContext {
    return new DavRequestContext(env, request, body, path, application, new CalendarService(env), new CalendarObjectMappingDAO(env.DB));
  }

  public get applicationId(): string {
    return this.application.applicationId;
  }

  public get calendarId(): string | undefined {
    return this.path.calendarId;
  }

  public get objectHref(): string | undefined {
    return this.path.objectHref;
  }

  /**
   * The provider access token, fetched at most once per request.
   *
   * Memoised because several handlers need it, and each fetch is a round trip to
   * the token endpoint on a cache miss.
   */
  public accessToken(): Promise<string> {
    this.accessTokenPromise ??= this.calendarService.getAccessToken(this.applicationId);
    return this.accessTokenPromise;
  }
}

/** DAV methods that carry a request body worth bounding. */
const DAV_BODY_METHODS: ReadonlySet<string> = new Set(['PROPFIND', 'REPORT', 'PUT']);

function davBodyLimit(method: string): number {
  return method === 'PUT' ? DAV_RESOURCE_MAX_BYTES : DAV_REQUEST_BODY_MAX_BYTES;
}

/**
 * Read a DAV request body, refusing anything over `maxBytes` before it is parsed.
 *
 * The limit is checked against `Content-Length` first so a large upload is
 * rejected on its declared size alone. The body is then read and measured again,
 * because that header is client-supplied: it may be absent, or simply wrong, and
 * it is the byte count of what actually arrived that matters. A `Request` body is
 * single-use, which is why this happens once, here, and the result is carried on
 * the context.
 */
async function readDavBody(request: Request): Promise<string> {
  if (!DAV_BODY_METHODS.has(request.method)) return '';
  const maxBytes = davBodyLimit(request.method);
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new RequestEntityTooLargeError();
  const body = await request.text();
  if (new TextEncoder().encode(body).length > maxBytes) throw new RequestEntityTooLargeError();
  return body;
}

export { DavRequestContext, readDavBody };
