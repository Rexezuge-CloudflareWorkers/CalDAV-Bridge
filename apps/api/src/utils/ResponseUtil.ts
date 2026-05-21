import { HttpError } from './HttpError';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function textResponse(value: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(value, { status, headers });
}

function errorResponse(error: unknown): Response {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : 'Internal server error.';
  if (status >= 500) console.error(error);
  return jsonResponse({ error: message }, status);
}

export { errorResponse, jsonResponse, textResponse };
