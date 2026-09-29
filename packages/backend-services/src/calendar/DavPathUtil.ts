/**
 * DAV paths, hrefs and the tokens derived from them.
 *
 * Split out from the response builder because this is the half of the CalDAV
 * surface that handles *input*: every value here arrives from a client and is
 * either used as a lookup key or echoed into a response. Keeping it apart from
 * XML serialisation means the containment and decoding rules have one place to
 * live, and can be read on their own.
 */

type DavResourceKind = 'root' | 'principal' | 'calendarHome' | 'calendar' | 'object' | 'unknown' | 'invalid';

interface DavPath {
  resource: DavResourceKind;
  applicationId?: string | undefined;
  calendarId?: string | undefined;
  objectHref?: string | undefined;
}

/** Namespace for the tokens this server issues, so a foreign one is recognisable. */
const SYNC_TOKEN_PREFIX = 'caldav-bridge:';

/** Percent-decoding that reports a malformed escape instead of throwing. */
function safeDecodeURIComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

class DavPathUtil {
  /**
   * Parse a request target into the resource it addresses.
   *
   * `invalid` is distinct from `unknown` on purpose. A malformed escape or a
   * traversal is a broken request, and answering `404` would tell the client
   * the resource does not exist when in fact it asked something the server
   * cannot read.
   */
  public static parsePath(pathname: string): DavPath {
    const parts: string[] = [];
    for (const segment of pathname.split('/')) {
      if (!segment) continue;
      const decoded = safeDecodeURIComponent(segment);
      if (decoded === undefined) return { resource: 'invalid' };
      parts.push(decoded);
    }
    if (parts[0] !== 'dav') return { resource: 'unknown' };
    if (parts.length === 1) return { resource: 'root' };
    if (parts[1] === 'principals' && parts[2] && parts.length <= 3) return { resource: 'principal', applicationId: parts[2] };
    if (parts[1] !== 'calendars' || !parts[2]) return { resource: 'unknown' };
    if (!parts[3]) return { resource: 'calendarHome', applicationId: parts[2] };
    if (!parts[4]) return { resource: 'calendar', applicationId: parts[2], calendarId: parts[3] };
    const objectHref = parts.slice(4).join('/');
    if (!DavPathUtil.isContainedObjectHref(objectHref)) return { resource: 'invalid' };
    return { resource: 'object', applicationId: parts[2], calendarId: parts[3], objectHref };
  }

  /**
   * Reject any href that could name something outside its own collection.
   *
   * Nesting is allowed because clients legitimately address objects through
   * sub-collections, and the mapping lookups are already scoped by
   * `applicationId`/`calendarId`. What is not allowed is a `.` or `..`
   * component or a backslash separator: `URL` normalises a literal `..` out of
   * a pathname but not `%2e%2e`, so a traversal that survived decoding would
   * ride into the mapping DAO and on into anything that later joins an href into
   * a path or a log line.
   */
  public static isContainedObjectHref(objectHref: string): boolean {
    if (!objectHref || objectHref.includes('\\')) return false;
    return !objectHref.split('/').some((segment) => segment === '.' || segment === '..');
  }

  /**
   * Resolve a href from a `calendar-multiget` to an object in this collection.
   *
   * A bare relative href is accepted because some clients send one, but it is
   * held to the same containment rule -- otherwise `../../other` would be
   * accepted as a legitimate object name.
   */
  public static objectHrefFromDavHref(href: string, applicationId: string, calendarId: string): string | undefined {
    let pathname = href;
    try {
      pathname = new URL(href, 'https://caldav-bridge.invalid').pathname;
    } catch {
      pathname = href;
    }
    const path = DavPathUtil.parsePath(pathname);
    if (path.resource === 'object' && path.applicationId === applicationId && path.calendarId === calendarId) return path.objectHref;
    if (!href.startsWith('/')) {
      const decoded = safeDecodeURIComponent(href);
      return decoded !== undefined && DavPathUtil.isContainedObjectHref(decoded) ? decoded : undefined;
    }
    return undefined;
  }

  public static providerEventIdFromObjectHref(objectHref: string): string {
    return safeDecodeURIComponent(objectHref.replace(/\.ics$/i, '')) ?? '';
  }

  public static principalHref(applicationId: string): string {
    return `/dav/principals/${encodeURIComponent(applicationId)}/`;
  }

  public static calendarHomeHref(applicationId: string): string {
    return `/dav/calendars/${encodeURIComponent(applicationId)}/`;
  }

  public static calendarHref(applicationId: string, calendarId: string): string {
    return `${DavPathUtil.calendarHomeHref(applicationId)}${encodeURIComponent(calendarId)}/`;
  }

  public static objectHref(applicationId: string, calendarId: string, objectHref: string): string {
    return `${DavPathUtil.calendarHref(applicationId, calendarId)}${encodeURIComponent(objectHref)}`;
  }

  /**
   * The sync token identifying a collection at a version.
   *
   * The collection is encoded into the token so it can be validated later. That
   * is what makes a token from one calendar unusable on another: read as a bare
   * integer it would let a client jump the cursor and skip changes.
   */
  public static syncToken(applicationId: string, calendarId: string, syncVersion: number): string {
    return `${SYNC_TOKEN_PREFIX}${encodeURIComponent(applicationId)}:${encodeURIComponent(calendarId)}:${Math.max(0, Math.trunc(syncVersion))}`;
  }

  /**
   * The version a sync token refers to, for the collection it names.
   *
   * RFC 4791 §7.2 requires a token from elsewhere to be refused rather than
   * interpreted, so a client that has lost its state is told to re-provision
   * instead of being handed a full collection as though it had asked for a
   * delta. An absent token is the one legitimate exception: it is how a client
   * starts a sync.
   */
  public static parseSyncToken(
    syncToken: string | undefined,
    applicationId: string,
    calendarId: string,
  ): { version: number } | { invalid: true } {
    if (!syncToken) return { version: 0 };
    if (!syncToken.startsWith(SYNC_TOKEN_PREFIX)) return { invalid: true };
    const parts = syncToken.slice(SYNC_TOKEN_PREFIX.length).split(':');
    if (parts.length !== 3) return { invalid: true };
    const [tokenApplicationId, tokenCalendarId, rawVersion] = parts;
    if (safeDecodeURIComponent(tokenApplicationId as string) !== applicationId) return { invalid: true };
    if (safeDecodeURIComponent(tokenCalendarId as string) !== calendarId) return { invalid: true };
    if (!/^\d+$/.test(rawVersion as string)) return { invalid: true };
    return { version: Number(rawVersion) };
  }
}

export { DavPathUtil, safeDecodeURIComponent };
export type { DavPath, DavResourceKind };
