import { describe, expect, it, vi } from "vitest";
import { cached, getCache, invalidateCache } from "./cache";

// A minimal in-memory fake satisfying only the three KV methods cached() and
// invalidateCache() call. Values are stored as strings, matching Workers KV.
function createFakeKv(initial: Record<string, unknown> = {}) {
  const store = new Map<string, string>();
  for (const [key, value] of Object.entries(initial)) {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) store.set(key, serialized);
  }

  return {
    get: vi.fn<(key: string, options?: { type?: string }) => Promise<unknown>>(
      async (key, options) => {
        const value = store.get(key);
        if (value === undefined) return null;
        return options?.type === "json" ? JSON.parse(value) : value;
      },
    ),
    put: vi.fn<(key: string, value: string) => Promise<void>>(async (key, value) => {
      store.set(key, value);
    }),
    delete: vi.fn<(key: string) => Promise<void>>(async (key) => {
      store.delete(key);
    }),
    store,
  };
}

describe("getCache", () => {
  it("returns the Workers KV binding", () => {
    const fake = createFakeKv();
    const env = { CACHE: fake as unknown as KVNamespace } as Parameters<typeof getCache>[0];

    expect(getCache(env)).toBe(fake);
  });

  it("returns null when the binding is unavailable", () => {
    expect(getCache({} as Parameters<typeof getCache>[0])).toBeNull();
  });
});

describe("cached", () => {
  it("returns the loader's value directly when the KV binding is unavailable", async () => {
    const loader = vi.fn<() => Promise<string>>(async () => "fresh-value");

    const result = await cached(null, "some-key", 60, loader);

    expect(result).toBe("fresh-value");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("on a cache hit, returns the cached value without calling the loader", async () => {
    const fake = createFakeKv({ "hit-key": "cached-value" });
    const loader = vi.fn<() => Promise<string>>(async () => "fresh-value");

    const result = await cached(fake as unknown as KVNamespace, "hit-key", 60, loader);

    expect(result).toBe("cached-value");
    expect(loader).not.toHaveBeenCalled();
    expect(fake.get).toHaveBeenCalledWith("hit-key", { type: "json", cacheTtl: 30 });
    expect(fake.put).not.toHaveBeenCalled();
  });

  it("on a cache miss, calls the loader and stores the result with the given TTL", async () => {
    const fake = createFakeKv();
    const loader = vi.fn<() => Promise<string>>(async () => "fresh-value");

    const result = await cached(fake as unknown as KVNamespace, "miss-key", 60, loader);

    expect(result).toBe("fresh-value");
    expect(loader).toHaveBeenCalledTimes(1);
    expect(fake.put).toHaveBeenCalledWith("miss-key", JSON.stringify("fresh-value"), {
      expirationTtl: 60,
    });
  });

  it("falls back to the loader when the cache GET throws", async () => {
    const fake = createFakeKv();
    fake.get.mockRejectedValueOnce(new Error("KV unavailable"));
    const loader = vi.fn<() => Promise<string>>(async () => "fresh-value");

    const result = await cached(fake as unknown as KVNamespace, "some-key", 60, loader);

    expect(result).toBe("fresh-value");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("still returns the loader's value when the cache PUT throws", async () => {
    const fake = createFakeKv();
    fake.put.mockRejectedValueOnce(new Error("KV unavailable"));
    const loader = vi.fn<() => Promise<string>>(async () => "fresh-value");

    const result = await cached(fake as unknown as KVNamespace, "some-key", 60, loader);

    expect(result).toBe("fresh-value");
  });
});

describe("invalidateCache", () => {
  it("does nothing when cache is null", async () => {
    await expect(invalidateCache(null, "some-key")).resolves.toBeUndefined();
  });

  it("deletes the given key", async () => {
    const fake = createFakeKv({ "some-key": "value" });

    await invalidateCache(fake as unknown as KVNamespace, "some-key");

    expect(fake.delete).toHaveBeenCalledWith("some-key");
    expect(fake.store.has("some-key")).toBe(false);
  });

  it("does not throw when the cache delete throws", async () => {
    const fake = createFakeKv();
    fake.delete.mockRejectedValueOnce(new Error("KV unavailable"));

    await expect(
      invalidateCache(fake as unknown as KVNamespace, "some-key"),
    ).resolves.toBeUndefined();
  });
});
