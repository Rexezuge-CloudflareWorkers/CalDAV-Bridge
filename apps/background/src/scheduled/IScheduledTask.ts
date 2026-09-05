abstract class IScheduledTask<TEnv extends IEnv> {
  public async handle(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return this.handleScheduledTask(event, env as unknown as TEnv, ctx);
  }

  protected abstract handleScheduledTask(event: ScheduledController, env: TEnv, ctx: ExecutionContext): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface IEnv {}

export { IScheduledTask };
export type { IEnv };
