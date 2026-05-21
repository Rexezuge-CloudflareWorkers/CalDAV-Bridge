import { RequestInputSchemas } from './input';

function getRouteKey(request: Request): string {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/api\/oauth2\/callback\/[^/]+$/, '/api/oauth2/callback/:applicationId');
  return `${request.method.toUpperCase()} ${pathname}`;
}

async function validateRequestInput(request: Request, body: unknown): Promise<{ success: true; data: unknown } | { success: false; error: string }> {
  const schema = RequestInputSchemas[getRouteKey(request)];
  if (!schema) return { success: true, data: body };
  const source = request.method.toUpperCase() === 'GET' ? Object.fromEntries(new URL(request.url).searchParams.entries()) : body;
  const parser = request.method.toUpperCase() === 'GET' ? schema.query : schema.body;
  if (!parser) return { success: true, data: source };
  const result = parser.safeParse(source);
  if (!result.success) return { success: false, error: result.error.issues[0]?.message || 'Invalid request.' };
  return { success: true, data: result.data };
}

export { validateRequestInput };
export * from './common';
export * from './input';
