// Stand-ins for the Workers Rate Limiting bindings the playground routes charge
// (the *_RATE_LIMITER entries in infra/wrangler.toml), plus a KV namespace that
// enforces KV's per-key write limit, for proving the routes no longer need it.

/** A rate limiter that also reports which keys it was asked to charge. */
export interface CountingRateLimiter extends RateLimit {
  /** Every key passed to `limit`, in call order, admitted or not. */
  readonly keys: readonly string[];
}

/**
 * Admit the first `limit` calls for each key and refuse the rest. There is no
 * clock: the period never rolls over, so every call in a test lands in the
 * same one. Charge it ahead of a request to start from a partly spent budget.
 */
export function countingRateLimiter(limit: number): CountingRateLimiter {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= limit };
    },
  };
}

/** A rate limiter whose budget is already spent for every key. */
export function refusingRateLimiter(): RateLimit {
  return {
    async limit() {
      return { success: false };
    },
  };
}

/**
 * In-memory KV covering the get/put subset the routes use, which enforces
 * Workers KV's one-write-per-key-per-second limit the way production does: the
 * second write to a key inside a second throws
 * "KV PUT failed: 429 Too Many Requests" (plain in-memory fakes never do).
 */
export function kvWithPerKeyWriteLimit(): KVNamespace {
  const values = new Map<string, string>();
  const lastWriteAt = new Map<string, number>();
  return {
    get: async (key: string, type?: unknown) => {
      const value = values.get(key) ?? null;
      if (value === null) return null;
      return type === "json" || (type as { type?: string })?.type === "json"
        ? JSON.parse(value)
        : value;
    },
    put: async (key: string, value: string) => {
      const previous = lastWriteAt.get(key);
      if (previous !== undefined && Date.now() - previous < 1000) {
        throw new Error("KV PUT failed: 429 Too Many Requests");
      }
      lastWriteAt.set(key, Date.now());
      values.set(key, value);
    },
  } as unknown as KVNamespace;
}
