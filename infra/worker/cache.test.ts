import { describe, expect, it } from "vite-plus/test";
import { getCache } from "./cache";

describe("getCache", () => {
  it("returns the Workers KV binding", () => {
    const fake = {} as KVNamespace;
    const env = { CACHE: fake } as Parameters<typeof getCache>[0];

    expect(getCache(env)).toBe(fake);
  });

  it("returns null when the binding is unavailable", () => {
    expect(getCache({} as Parameters<typeof getCache>[0])).toBeNull();
  });
});
