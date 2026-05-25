import { DatabaseCleanupTask } from '@/scheduled';

const CRON_TASKS_RUN_PATH = '/run';

interface CronTasksRunRequest {
  cron?: unknown;
  scheduledTime?: unknown;
}

class CronTasksWorker {
  private currentRun: Promise<void> | undefined;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  public async fetch(request: Request): Promise<Response> {
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

  private async runScheduledTaskRequest(request: Request): Promise<void> {
    await new DatabaseCleanupTask().handle(await this.createScheduledController(request), this.env, this.createExecutionContext());
  }

  private async createScheduledController(request: Request): Promise<ScheduledController> {
    const payload = await this.readRunRequest(request);
    return {
      cron: typeof payload.cron === 'string' ? payload.cron : '',
      scheduledTime: typeof payload.scheduledTime === 'number' ? payload.scheduledTime : Date.now(),
      noRetry: (): void => undefined,
    };
  }

  private async readRunRequest(request: Request): Promise<CronTasksRunRequest> {
    try {
      return (await request.json()) as CronTasksRunRequest;
    } catch {
      return {};
    }
  }

  private createExecutionContext(): ExecutionContext {
    return {
      waitUntil: (promise: Promise<unknown>): void => this.state.waitUntil(promise),
      passThroughOnException: (): void => undefined,
    } as unknown as ExecutionContext;
  }
}

export { CronTasksWorker };
