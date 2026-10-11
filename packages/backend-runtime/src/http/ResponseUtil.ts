import { ServiceError } from '@rexezuge/errors';
import { RetryAfterError } from '@caldav-bridge/shared';

function jsonResponse(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(value), {
    status,
    headers: responseHeaders,
  });
}

function textResponse(value: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(value, { status, headers });
}

/**
 * A fixed message for failures whose cause must not reach the client.
 *
 * Internal errors routinely carry schema, table, column and provider detail in
 * their message. That is logged, not returned: a caller needs to know the
 * request failed, not how the store is laid out.
 */
const INTERNAL_ERROR_MESSAGE = 'The server encountered an internal error.';

/**
 * Map any thrown value onto the `{ error }` JSON envelope.
 *
 * Adapted to the kit's taxonomy (`@rexezuge/errors`): classification is
 * `ServiceError.from`, the status is `mapped.status`, and the message is
 * `mapped.message` exactly when `mapped.expose` — the kit's decision field —
 * says it is safe. Transport headers (a `WWW-Authenticate` challenge, for
 * example) are the caller's to pass: the kit's taxonomy deliberately carries
 * no response decoration, so a caller needing one passes it in and nothing
 * here has to know which routes challenge.
 */
function errorResponse(error: unknown, headers?: HeadersInit): Response {
  const mapped = ServiceError.from(error);
  // The one transport decoration this repo's taxonomy subclass carries.
  const transport = headers ?? (error instanceof RetryAfterError ? error.headers : undefined);
  if (mapped.status >= 500) {
    console.error(error);
    return jsonResponse({ error: INTERNAL_ERROR_MESSAGE }, mapped.status, transport);
  }
  const message = mapped.expose ? mapped.message : (mapped.toErrorResponse().body.Exception?.Message ?? INTERNAL_ERROR_MESSAGE);
  return jsonResponse({ error: message }, mapped.status, transport);
}

export { errorResponse, jsonResponse, textResponse };
