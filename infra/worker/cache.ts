import type { Env } from "./env";

// Bump this to invalidate every cached key at once (e.g. after changing the
// shape of a cached value) without touching TTLs or adding individual deletes.
//
// v2: listPublishedLessons gained an `id` tiebreaker so its ordering is a
// total order. Pages are cached one key each, so without this bump a page 0
// cached under the old ordering could be paired with a page 1 computed under
// the new one — which is the very boundary duplicate the tiebreaker fixes,
// reintroduced for the length of the TTL after every deploy.
const KEY_VERSION = "v2";

// KV caches reads at each Cloudflare location. Keep that regional cache short
// so writes and invalidations made elsewhere become visible quickly while hot
// gallery reads still avoid a central KV lookup on every request.
const KV_READ_CACHE_TTL_SECONDS = 30;
const KV_MIN_EXPIRATION_TTL_SECONDS = 60;

export function lessonSlugKey(slug: string): string {
  return `l:${KEY_VERSION}:slug:${slug}`;
}

export function lessonListKey(page: number, pageSize: number): string {
  return `l:${KEY_VERSION}:list:${page}:${pageSize}`;
}

export function playlistSlugKey(slug: string): string {
  return `p:${KEY_VERSION}:slug:${slug}`;
}

// The checked-in Wrangler config provides this binding, but keeping it
// optional lets self-hosted/test environments omit the cache without changing
// application behavior.
export function getCache(env: Env): KVNamespace | null {
  return env.CACHE ?? null;
}

// Cache-aside read-through: serve `key` from KV when present, otherwise
// call `loader` (the real D1 query) and populate the cache for `ttlSeconds`.
// Every KV call is wrapped so a missing/unreachable/rate-limited cache
// degrades to calling `loader` directly rather than turning into a request
// failure — cache availability must never be able to take the app down.
export async function cached<T>(
  cache: KVNamespace | null,
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  if (!cache) {
    return loader();
  }

  try {
    const hit = await cache.get<T>(key, {
      type: "json",
      cacheTtl: KV_READ_CACHE_TTL_SECONDS,
    });
    if (hit !== null) {
      return hit;
    }
  } catch (error) {
    console.error("Cache read failed", { key }, error);
  }

  const value = await loader();

  try {
    const serialized = JSON.stringify(value);
    // `value === null` is skipped, not just `serialized === undefined`:
    // JSON.stringify(null) is the string "null", so a not-found lookup used to
    // pass this guard and write an entry — which the read above then rejects
    // (`hit !== null`), so it could never be served. Every unauthenticated
    // request for a nonexistent slug or an out-of-range page therefore minted a
    // billable KV write, at an attacker-chosen key, that did nothing. Skipping
    // it changes no behaviour: such an entry was never readable.
    if (value !== null && serialized !== undefined) {
      await cache.put(key, serialized, {
        expirationTtl: Math.max(ttlSeconds, KV_MIN_EXPIRATION_TTL_SECONDS),
      });
    }
  } catch (error) {
    console.error("Cache write failed", { key }, error);
  }

  return value;
}

// Best-effort invalidation — a failed delete just means the key survives until
// its TTL expires, not a request failure. KV is eventually consistent, so a
// deleted value can also remain visible in another location's short read cache.
export async function invalidateCache(cache: KVNamespace | null, key: string): Promise<void> {
  if (!cache) return;
  try {
    await cache.delete(key);
  } catch (error) {
    console.error("Cache invalidation failed", { key }, error);
  }
}
