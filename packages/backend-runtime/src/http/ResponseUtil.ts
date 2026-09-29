import { ServiceError } from '@caldav-bridge/backend-errors';

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

function errorResponse(error: unknown): Response {
  const status = error instanceof ServiceError ? error.getErrorCode() : 500;
  const headers = error instanceof ServiceError ? error.headers : undefined;
  if (status >= 500) {
    console.error(error);
    return jsonResponse({ error: INTERNAL_ERROR_MESSAGE }, status, headers);
  }
  const message = error instanceof Error ? error.message : INTERNAL_ERROR_MESSAGE;
  return jsonResponse({ error: message }, status, headers);
}

export { errorResponse, jsonResponse, textResponse };
