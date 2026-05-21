import { HttpError } from './HttpError';

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

function errorResponse(error: unknown): Response {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : 'Internal server error.';
  if (status >= 500) console.error(error);
  return jsonResponse({ error: message }, status, error instanceof HttpError ? error.headers : undefined);
}

export { errorResponse, jsonResponse, textResponse };
