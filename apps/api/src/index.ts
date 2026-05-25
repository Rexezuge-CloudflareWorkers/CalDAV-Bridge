import { CalDavBridgeWorker } from './workers/CalDavBridgeWorker';
export { CronTasksWorker } from './workers/CronTasksWorker';
export { OAuth2TokenRefreshWorker } from './workers/OAuth2TokenRefreshWorker';

const calDavBridgeWorker = new CalDavBridgeWorker();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return calDavBridgeWorker.fetch(request, env, ctx);
  },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return calDavBridgeWorker.scheduled(controller, env, ctx);
  },
};
