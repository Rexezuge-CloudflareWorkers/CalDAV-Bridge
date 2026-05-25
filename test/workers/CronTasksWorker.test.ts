import { beforeEach, describe, expect, it, vi } from 'vitest';

const { databaseCleanupHandle } = vi.hoisted(() => ({
  databaseCleanupHandle: vi.fn(),
}));

vi.mock('@/scheduled', () => ({
  DatabaseCleanupTask: class {
    handle = databaseCleanupHandle;
  },
}));

import { CronTasksWorker } from '@/workers/CronTasksWorker';

describe('CronTasksWorker', () => {
  beforeEach(() => {
    databaseCleanupHandle.mockReset();
    databaseCleanupHandle.mockResolvedValue(undefined);
  });

  it('runs database cleanup for scheduled requests', async () => {
    const env = {} as Env;
    const worker = new CronTasksWorker(fakeDurableObjectState(), env);

    const response = await worker.fetch(runRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'completed' });
    expect(databaseCleanupHandle).toHaveBeenCalledOnce();
    const scheduledEvent = databaseCleanupHandle.mock.calls[0][0] as ScheduledController;
    expect(scheduledEvent.cron).toBe('0 4 * * *');
    expect(scheduledEvent.scheduledTime).toBe(123456);
    expect(databaseCleanupHandle.mock.calls[0][1]).toBe(env);
  });

  it('returns accepted when a cleanup run is already active', async () => {
    let resolveFirstRun: () => void = () => undefined;
    databaseCleanupHandle.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveFirstRun = resolve;
      }),
    );
    const worker = new CronTasksWorker(fakeDurableObjectState(), {} as Env);
    const firstResponse = worker.fetch(runRequest());
    await Promise.resolve();
    await Promise.resolve();

    const secondResponse = await worker.fetch(runRequest());

    expect(secondResponse.status).toBe(202);
    await expect(secondResponse.json()).resolves.toEqual({ status: 'already_running' });
    resolveFirstRun();
    await expect(firstResponse).resolves.toHaveProperty('status', 200);
  });

  it('rejects unsupported routes and methods', async () => {
    const worker = new CronTasksWorker(fakeDurableObjectState(), {} as Env);

    const missing = await worker.fetch(new Request('https://cron-tasks.internal/missing', { method: 'POST' }));
    const method = await worker.fetch(new Request('https://cron-tasks.internal/run', { method: 'GET' }));

    expect(missing.status).toBe(404);
    expect(method.status).toBe(405);
    expect(method.headers.get('Allow')).toBe('POST');
  });
});

function runRequest(): Request {
  return new Request('https://cron-tasks.internal/run', {
    method: 'POST',
    body: JSON.stringify({ cron: '0 4 * * *', scheduledTime: 123456 }),
  });
}

function fakeDurableObjectState(): DurableObjectState {
  return { waitUntil: vi.fn() } as unknown as DurableObjectState;
}
