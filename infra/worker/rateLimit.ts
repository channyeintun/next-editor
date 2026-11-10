import type { Context } from "hono";

// Per-caller limit through a Workers Rate Limiting binding. Approximate by
// design (Cloudflare counts per location), but fail closed when the binding is
// missing or unavailable so a configuration outage cannot turn a route into an
// unlimited proxy.
export type RateLimitDecision = "allowed" | "limited" | "unavailable";

/**
 * Charge one call against `key`'s budget on `limiter`.
 *
 * Each budget is its own binding, declared with its limit and period in
 * infra/wrangler.toml. `label` only ever reaches console.error; user sources,
 * output and the key itself must never be logged.
 */
export async function checkRateLimit(
  limiter: RateLimit | undefined,
  options: { key: string; label: string },
): Promise<RateLimitDecision> {
  if (!limiter) {
    return "unavailable";
  }
  try {
    const { success } = await limiter.limit({ key: options.key });
    return success ? "allowed" : "limited";
  } catch {
    console.error(`${options.label} rate-limit check failed`);
    return "unavailable";
  }
}

/**
 * Charge one request against a signed-in user's budget on `limiter` (keyed
 * "user:<id>"), for the routes that write to shared storage: the refusal is
 * the response to send, null means go ahead. Fails closed like
 * checkRateLimit: a missing or failing binding answers 503, so a
 * configuration outage cannot lift the limit.
 */
export async function chargeUserWriteBudget(
  c: Context,
  limiter: RateLimit | undefined,
  userId: string,
  label: string,
): Promise<Response | null> {
  const decision = await checkRateLimit(limiter, { key: `user:${userId}`, label });
  if (decision === "allowed") return null;
  if (decision === "limited") return c.json({ error: "too many requests; retry in a minute" }, 429);
  return c.json({ error: `${label} is temporarily unavailable` }, 503);
}
