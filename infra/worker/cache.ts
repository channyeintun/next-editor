import { Redis } from "@upstash/redis/cloudflare";
import type { Env } from "./env";

// Bump this to invalidate every cached key at once (e.g. after changing the
// shape of a cached value) without touching TTLs or adding individual DEL calls.
const KEY_VERSION = "v1";

export function lessonSlugKey(slug: string): string {
  return `l:${KEY_VERSION}:slug:${slug}`;
}

export function lessonListKey(page: number, pageSize: number): string {
  return `l:${KEY_VERSION}:list:${page}:${pageSize}`;
}

// Upstash is optional — self-hosted/local setups may not have credentials
// configured (see infra/.dev.vars, infra/wrangler.toml), and the app must
// behave identically without them.
export function getCache(env: Env): Redis | null {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    return null;
  }
  return new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });
}

// Cache-aside read-through: serve `key` from Redis when present, otherwise
// call `loader` (the real D1 query) and populate the cache for `ttlSeconds`.
// Every Redis call is wrapped so a missing/unreachable/rate-limited cache
// degrades to calling `loader` directly rather than turning into a request
// failure — Upstash availability must never be able to take the app down.
export async function cached<T>(
  cache: Redis | null,
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  if (!cache) {
    return loader();
  }

  try {
    const hit = await cache.get<T>(key);
    if (hit !== null) {
      return hit;
    }
  } catch (error) {
    console.error("Cache read failed for key", key, error);
  }

  const value = await loader();

  try {
    await cache.set(key, value, { ex: ttlSeconds });
  } catch (error) {
    console.error("Cache write failed for key", key, error);
  }

  return value;
}

// Best-effort invalidation — a failed DEL just means the key survives until
// its TTL expires, not a request failure.
export async function invalidateCache(cache: Redis | null, key: string): Promise<void> {
  if (!cache) return;
  try {
    await cache.del(key);
  } catch (error) {
    console.error("Cache invalidation failed for key", key, error);
  }
}
