/**
 * Stand-in for the `cloudflare:workers` module, which has no Node equivalent.
 *
 * Only the parts the tests reach are provided: a durable object has durable
 * state and an environment, and nothing else. Re-exporting the class under the
 * same name it shadows is deliberate -- `AbstractDurableObjectWorker` extends the
 * real one, and the test needs it to be a real subclass.
 */
import type { DurableObject as CloudflareDurableObject } from 'cloudflare:workers';

class DurableObject<TEnv = Env> {
  protected ctx: DurableObjectState;
  protected env: TEnv;

  constructor(ctx: DurableObjectState, env: TEnv) {
    this.ctx = ctx;
    this.env = env;
  }
}

// The import above is type-only, so this is the value the mocked module yields.
export type { CloudflareDurableObject };
export { DurableObject };
