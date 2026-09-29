import { describe, expect, it, vi } from 'vitest';
import { AbstractDurableObjectWorker } from '@caldav-bridge/backend-runtime/base';
import { AbstractEntrypointWorker } from '@caldav-bridge/backend-runtime/base';

/** A worker that records what it was asked to handle and can be told to fail. */
class ProbeEntrypoint extends AbstractEntrypointWorker {
  public lastRequest?: Request;
  public lastScheduled?: { cron: string; scheduledTime: number };
  public failure?: Error;

  protected async onRequest(request: Request): Promise<Response> {
    this.lastRequest = request;
    if (this.failure) throw this.failure;
    return new Response('handled', { status: 200 });
  }

  protected async onScheduled(event: ScheduledController): Promise<void> {
    this.lastScheduled = { cron: event.cron, scheduledTime: event.scheduledTime };
    if (this.failure) throw this.failure;
  }
}

class ProbeDurableObject extends AbstractDurableObjectWorker {
  public failure?: Error;

  protected async onRequest(): Promise<Response> {
    if (this.failure) throw this.failure;
    return new Response('handled', { status: 200 });
  }
}

const CONTEXT = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const EVENT = { cron: '0 4 * * *', scheduledTime: 1234, noRetry: vi.fn() } as unknown as ScheduledController;

describe('AbstractEntrypointWorker', () => {
  it('passes a request through to the implementation', async () => {
    const worker = new ProbeEntrypoint();

    const response = await worker.fetch(new Request('https://bridge.example.test/user/me'), {} as Env, CONTEXT);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('handled');
  });

  it('contains a handler failure instead of letting it reach the platform', async () => {
    const worker = new ProbeEntrypoint();
    worker.failure = new Error('database exploded');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await worker.fetch(new Request('https://bridge.example.test/user/me'), {} as Env, CONTEXT);

    // This is the last line of defence: without it, an unhandled rejection in a
    // handler becomes a platform-level 500 with no response of our own.
    expect(response.status).toBe(500);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  /**
   * A cron trigger cannot be invoked by an HTTP client without reaching the
   * token minting, so this path is how a run is started manually.
   */
  it('treats a /__scheduled request as a cron run rather than a request', async () => {
    const worker = new ProbeEntrypoint();

    const response = await worker.fetch(new Request('https://bridge.example.test/__scheduled?cron=0+4+*+*+*'), {} as Env, CONTEXT);

    expect(response.status).toBe(204);
    expect(worker.lastScheduled?.cron).toBe('0 4 * * *');
    expect(worker.lastRequest).toBeUndefined();
  });

  it('defaults a cron with no query parameter to the empty string', async () => {
    const worker = new ProbeEntrypoint();

    await worker.fetch(new Request('https://bridge.example.test/__scheduled'), {} as Env, CONTEXT);

    expect(worker.lastScheduled?.cron).toBe('');
  });

  it('logs and swallows a failing cron run, which has no caller to report to', async () => {
    const worker = new ProbeEntrypoint();
    worker.failure = new Error('cleanup failed');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // A cron failure has no response to fail; letting it reject would surface as
    // a platform error and lose the signal that the task itself failed.
    await expect(worker.scheduled(EVENT, {} as Env, CONTEXT)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('resolves a successful cron run quietly', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await new ProbeEntrypoint().scheduled(EVENT, {} as Env, CONTEXT);

    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe('AbstractDurableObjectWorker', () => {
  it('passes a request through to the implementation', async () => {
    const state = { waitUntil: vi.fn() } as unknown as DurableObjectState;
    const worker = new ProbeDurableObject(state, {} as Env);

    const response = await worker.fetch(new Request('https://durable.invalid/run'));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('handled');
  });

  it('answers a handler failure with JSON rather than an unhandled rejection', async () => {
    const state = { waitUntil: vi.fn() } as unknown as DurableObjectState;
    const worker = new ProbeDurableObject(state, {} as Env);
    worker.failure = new Error('token refresh failed');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await worker.fetch(new Request('https://durable.invalid/run'));

    // A durable object is called by a sibling worker over a stub, so it has to
    // answer with a response rather than throw into the caller.
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Internal Error' });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('does not leak the failure message in the JSON body', async () => {
    const state = { waitUntil: vi.fn() } as unknown as DurableObjectState;
    const worker = new ProbeDurableObject(state, {} as Env);
    worker.failure = new Error('AES_ENCRYPTION_KEY_SECRET is missing');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await worker.fetch(new Request('https://durable.invalid/run'));

    expect(await response.text()).not.toContain('AES_ENCRYPTION_KEY_SECRET');
    logged.mockRestore();
  });
});
