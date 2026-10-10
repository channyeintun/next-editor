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
