import { describe, expect, it, vi } from "vitest";
import { cached, invalidateCache } from "./cache";
import type { Redis } from "@upstash/redis/cloudflare";

// A minimal in-memory fake satisfying only the three Redis methods cached()
// and invalidateCache() actually call — cast to Redis since the real client
// isn't constructible without live Upstash credentials.
function createFakeRedis(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: vi.fn<(key: string) => Promise<unknown>>(async (key) =>
      store.has(key) ? store.get(key) : null,
    ),
    set: vi.fn<(key: string, value: unknown) => Promise<string>>(async (key, value) => {
      store.set(key, value);
      return "OK";
    }),
    del: vi.fn<(key: string) => Promise<number>>(async (key) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    }),
    store,
  };
}

describe("cached", () => {
  it("returns the loader's value directly when cache is null (Upstash not configured)", async () => {
    const loader = vi.fn<() => Promise<string>>(async () => "fresh-value");

    const result = await cached(null, "some-key", 60, loader);

    expect(result).toBe("fresh-value");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("on a cache hit, returns the cached value without calling the loader", async () => {
    const fake = createFakeRedis({ "hit-key": "cached-value" });
    const loader = vi.fn<() => Promise<string>>(async () => "fresh-value");

    const result = await cached(fake as unknown as Redis, "hit-key", 60, loader);

    expect(result).toBe("cached-value");
    expect(loader).not.toHaveBeenCalled();
    expect(fake.set).not.toHaveBeenCalled();
  });

  it("on a cache miss, calls the loader and stores the result with the given TTL", async () => {
    const fake = createFakeRedis();
    const loader = vi.fn<() => Promise<string>>(async () => "fresh-value");

    const result = await cached(fake as unknown as Redis, "miss-key", 60, loader);

    expect(result).toBe("fresh-value");
    expect(loader).toHaveBeenCalledTimes(1);
    expect(fake.set).toHaveBeenCalledWith("miss-key", "fresh-value", { ex: 60 });
  });

  it("falls back to the loader when the cache GET throws", async () => {
    const fake = createFakeRedis();
    fake.get.mockRejectedValueOnce(new Error("upstash unreachable"));
    const loader = vi.fn<() => Promise<string>>(async () => "fresh-value");

    const result = await cached(fake as unknown as Redis, "some-key", 60, loader);

    expect(result).toBe("fresh-value");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("still returns the loader's value when the cache SET throws", async () => {
    const fake = createFakeRedis();
    fake.set.mockRejectedValueOnce(new Error("upstash unreachable"));
    const loader = vi.fn<() => Promise<string>>(async () => "fresh-value");

    const result = await cached(fake as unknown as Redis, "some-key", 60, loader);

    expect(result).toBe("fresh-value");
  });
});

describe("invalidateCache", () => {
  it("does nothing when cache is null", async () => {
    await expect(invalidateCache(null, "some-key")).resolves.toBeUndefined();
  });

  it("deletes the given key", async () => {
    const fake = createFakeRedis({ "some-key": "value" });

    await invalidateCache(fake as unknown as Redis, "some-key");

    expect(fake.del).toHaveBeenCalledWith("some-key");
    expect(fake.store.has("some-key")).toBe(false);
  });

  it("does not throw when the cache DEL throws", async () => {
    const fake = createFakeRedis();
    fake.del.mockRejectedValueOnce(new Error("upstash unreachable"));

    await expect(invalidateCache(fake as unknown as Redis, "some-key")).resolves.toBeUndefined();
  });
});
