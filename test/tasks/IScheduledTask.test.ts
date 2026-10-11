import { describe, expect, it, vi } from 'vitest';
import { IScheduledTask } from '@caldav-bridge/background/scheduled/IScheduledTask';
import type { IEnv } from '@caldav-bridge/background/scheduled/IScheduledTask';

/**
 * The scheduled-task base, pinned on the one thing it does.
 *
 * `handle` is the worker's `scheduled` entry point: the Durable Object hands it
 * the raw `ScheduledController` and the module-level `Env`, and the base's
 * whole job is to hand the subclass the *typed* environment. A task that reads
 * `env.DB` through its own type parameter would otherwise see the untyped
 * binding, and the cast would have to be repeated in every task.
 */
class RecordingTask extends IScheduledTask<IEnv> {
  public readonly seen: { cron: string; env: unknown; waited: unknown[] } = { cron: '', env: undefined, waited: [] };

  protected async handleScheduledTask(event: ScheduledController, env: IEnv, ctx: ExecutionContext): Promise<void> {
    this.seen.cron = event.cron;
    this.seen.env = env;
    this.seen.waited.push(ctx.waitUntil(Promise.resolve('waited')));
  }
}

describe('IScheduledTask', () => {
  it('forwards the scheduled event and the typed environment to the task', async () => {
    const task = new RecordingTask();
    const controller = { cron: '0 4 * * *', scheduledTime: 1, noRetry: vi.fn() } as ScheduledController;
    const env = { DB: 'binding' } as unknown as IEnv;
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

    await task.handle(controller, env as unknown as Env, ctx);

    expect(task.seen.cron).toBe('0 4 * * *');
    expect(task.seen.env).toBe(env);
  });

  it('resolves to nothing when the task does, so the worker awaits it', async () => {
    // `scheduled` handlers are awaited by the runtime; an unhandled rejection
    // inside a task must surface there rather than being swallowed by a
    // fire-and-forget in the base.
    const task = new RecordingTask();
    const controller = { cron: '* * * * *', scheduledTime: 2, noRetry: vi.fn() } as ScheduledController;
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

    await expect(task.handle(controller, {} as unknown as Env, ctx)).resolves.toBeUndefined();
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
  });
});
