import { describe, expect, it } from 'vitest';
import { CalDavBridgeWorker } from '@/workers';
import { DAV_REQUEST_BODY_MAX_BYTES } from '@caldav-bridge/shared/constants';

/**
 * Body-size limits are enforced before a DAV body is parsed or forwarded, and
 * an oversized body must be reported as `413` rather than reaching the XML
 * scanner or a provider at all.
 */
describe('DAV request body limits', () => {
  it('rejects a PROPFIND body over the limit with 413', async () => {
    const response = await fetchWorker(
      new Request('https://bridge.example.test/dav/', {
        method: 'PROPFIND',
        headers: { Authorization: basicAuth() },
        body: 'x'.repeat(DAV_REQUEST_BODY_MAX_BYTES + 1),
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.text()).resolves.toContain('<D:error');
  });

  it('rejects an oversized body declared by Content-Length without reading it', async () => {
    const response = await fetchWorker(
      new Request('https://bridge.example.test/dav/', {
        method: 'PROPFIND',
        headers: { Authorization: basicAuth(), 'Content-Length': String(DAV_REQUEST_BODY_MAX_BYTES + 1) },
        body: '',
      }),
    );

    expect(response.status).toBe(413);
  });

  it('still answers DAV OPTIONS and routing before any body is read', async () => {
    const options = await fetchWorker(new Request('https://bridge.example.test/dav', { method: 'OPTIONS' }));
    expect(options.status).toBe(204);

    const unknown = await fetchWorker(new Request('https://bridge.example.test/dav/unknown/path', { method: 'GET' }));
    expect(unknown.status).toBe(404);
  });
});

/** A well-formed `Authorization` header; the request is rejected on size before it is used. */
function basicAuth(): string {
  return `Basic ${btoa('user:password')}`;
}

function fetchWorker(request: Request): Promise<Response> {
  return new CalDavBridgeWorker().fetch(request, {} as Env, {} as ExecutionContext);
}
