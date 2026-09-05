import { DurableObject } from 'cloudflare:workers';

class DurableObject<TEnv = Env> {
  protected ctx: DurableObjectState;
  protected env: TEnv;

  constructor(ctx: DurableObjectState, env: TEnv) {
    this.ctx = ctx;
    this.env = env;
  }
}

export { DurableObject };
