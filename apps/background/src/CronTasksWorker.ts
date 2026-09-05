import { AbstractDurableObjectWorker } from '@caldav-bridge/backend-runtime/base';
import { DatabaseCleanupTask } from '@caldav-bridge/background/scheduled';

const CRON_TASKS_RUN_PATH = '/run';

interface CronTasksRunRequest {
  cron?: unknown;
  scheduledTime?: unknown;
}

class CronTasksWorker extends AbstractDurableObjectWorker {
  protected currentRun: Promise<void> | undefined;

  protected async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== CRON_TASKS_RUN_PATH) return Response.json({ error: 'Not Found' }, { status: 404 });
    if (request.method !== 'POST') return Response.json({ error: 'Method Not Allowed' }, { status: 405, headers: { Allow: 'POST' } });
    if (this.currentRun) return Response.json({ status: 'already_running' }, { status: 202 });

    const run = this.runScheduledTaskRequest(request);
    this.currentRun = run;
    try {
      await run;
      return Response.json({ status: 'completed' });
    } catch (error) {
      console.error('Cron task run failed:', error);
      return Response.json({ status: 'failed' }, { status: 500 });
    } finally {
      if (this.currentRun === run) this.currentRun = undefined;
    }
  }

  protected async runScheduledTaskRequest(request: Request): Promise<void> {
    await this.runScheduledTasks(await this.createScheduledController(request));
  }

  protected async createScheduledController(request: Request): Promise<ScheduledController> {
    const payload = await this.readRunRequest(request);
    return {
      cron: typeof payload.cron === 'string' ? payload.cron : '',
      scheduledTime: typeof payload.scheduledTime === 'number' ? payload.scheduledTime : Date.now(),
      noRetry: (): void => undefined,
    };
  }

  protected async readRunRequest(request: Request): Promise<CronTasksRunRequest> {
    try {
      return (await request.json()) as CronTasksRunRequest;
    } catch {
      return {};
    }
  }

  protected async runScheduledTasks(event: ScheduledController): Promise<void> {
    const ctx: ExecutionContext = this.createExecutionContext();
    await Promise.all([new DatabaseCleanupTask().handle(event, this.env, ctx)]);
  }
}

export { CronTasksWorker };
