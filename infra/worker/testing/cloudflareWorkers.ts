// Node stand-in for the `cloudflare:workers` module, which exists only inside
// workerd. infra/worker/vitest.config.ts aliases the module here so Durable
// Object classes can be constructed in tests; their types still come from
// @cloudflare/workers-types.
export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
