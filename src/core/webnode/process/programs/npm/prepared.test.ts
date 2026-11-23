// @vitest-environment node
import { describe, expect, it } from "vitest";
import { depsObjectPath } from "../../../depsObjects";
import { LOCK_VERSION } from "./install";
import { PLAN_VERSION, encodePlan } from "./plan";
import type { DependencyPlan } from "./plan";
import { createPreparedInstalls, depsObjectIdOf, preparedInstallsWanted } from "./prepared";
import { DEFAULT_REGISTRY } from "./registry";
import type { TarballCache } from "./registry";

const ORIGIN = "https://runtime.example.test";
const encoder = new TextEncoder();

/** Objects served from `ORIGIN`, by id; `status` overrides what one answers. */
function createObjectHost() {
  const objects = new Map<string, Uint8Array>();
  const requests: { url: string; init?: RequestInit }[] = [];
  const status = new Map<string, number[]>();
  return {
    objects,
    requests,
    status,
    async add(bytes: Uint8Array) {
      const id = await depsObjectIdOf(bytes);
      objects.set(id, bytes);
      return id;
    },
    fetch: async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      const id = url.slice(`${ORIGIN}${depsObjectPath("")}`.length);
      const planned = status.get(id)?.shift();
      if (planned !== undefined) {
        return new Response("", { status: planned });
      }
      const bytes = objects.get(id);
      return bytes
        ? new Response(bytes.slice().buffer, { status: 200 })
        : new Response("", { status: 404 });
    },
  };
}

function createMemoryCache() {
  const store = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  const cache: TarballCache = {
    match: async (url) => {
      const bytes = store.get(url);
      return bytes ? new Response(bytes.slice().buffer) : undefined;
    },
    put: async (url, response) => {
      const bytes = new Uint8Array(await response.arrayBuffer());
      await new Promise((resolve) => setTimeout(resolve, 10));
      store.set(url, bytes);
    },
    delete: async (url) => {
      deleted.push(url);
      return store.delete(url);
    },
  };
  return { store, deleted, cache };
}

function planFor(hash: string): DependencyPlan {
  return {
    planVersion: PLAN_VERSION,
    lockfileVersion: LOCK_VERSION,
    manifestHash: hash,
    packages: {},
    layout: [],
    root: {},
    warnings: ["w"],
  };
}

describe("preparedInstallsWanted", () => {
  const wanted = { origin: ORIGIN, registry: DEFAULT_REGISTRY, env: {} };
  it("wants them with an http(s) origin, the default registry and no switch", () => {
    expect(preparedInstallsWanted(wanted)).toBe(true);
    expect(preparedInstallsWanted({ ...wanted, origin: "http://runtime.localhost:5173" })).toBe(
      true,
    );
    expect(preparedInstallsWanted({ ...wanted, env: { WEBNODE_DEPS: "1" } })).toBe(true);
  });

  it("does not want them otherwise", () => {
    expect(preparedInstallsWanted({ ...wanted, origin: undefined })).toBe(false);
    expect(preparedInstallsWanted({ ...wanted, origin: "null" })).toBe(false);
    expect(preparedInstallsWanted({ ...wanted, origin: "blob:x" })).toBe(false);
    expect(preparedInstallsWanted({ ...wanted, registry: "https://registry.test" })).toBe(false);
    expect(preparedInstallsWanted({ ...wanted, env: { WEBNODE_DEPS: "0" } })).toBe(false);
  });
});

describe("createPreparedInstalls", () => {
  it("asks for nothing when the index has no row", async () => {
    const host = createObjectHost();
    const prepared = createPreparedInstalls({ fetch: host.fetch, origin: ORIGIN, index: {} });
    expect(await prepared.plan("a".repeat(64))).toBeNull();
    expect(await prepared.plan("constructor")).toBeNull();
    expect(host.requests).toEqual([]);
  });

  it("fetches a plan from the origin, without credentials or the HTTP cache", async () => {
    const host = createObjectHost();
    const hash = "a".repeat(64);
    const id = await host.add(encodePlan(planFor(hash)));
    const prepared = createPreparedInstalls({
      fetch: host.fetch,
      origin: `${ORIGIN}/`,
      index: { [hash]: id },
    });
    expect(await prepared.plan(hash)).toEqual(planFor(hash));
    expect(host.requests.map((request) => request.url)).toEqual([
      `${ORIGIN}/__webnode__/deps/${id}`,
    ]);
    expect(host.requests[0].init).toMatchObject({ cache: "no-store", credentials: "omit" });
  });

  it("refuses a plan whose bytes do not hash to its id, or that fails its checks", async () => {
    const host = createObjectHost();
    const hash = "a".repeat(64);
    const id = await host.add(encodePlan(planFor(hash)));
    host.objects.set(id, encodePlan(planFor("b".repeat(64))));
    const other = await host.add(encodePlan(planFor("b".repeat(64))));
    const prepared = createPreparedInstalls({
      fetch: host.fetch,
      origin: ORIGIN,
      index: { [hash]: id, ["c".repeat(64)]: other, ["d".repeat(64)]: "not-an-id" },
    });
    expect(await prepared.plan(hash)).toBeNull();
    expect(await prepared.plan("c".repeat(64))).toBeNull();
    expect(await prepared.plan("d".repeat(64))).toBeNull();
    expect(host.requests).toHaveLength(2);
  });

  it("answers null for an archive that is missing or does not match, and retries a 5xx", async () => {
    const host = createObjectHost();
    const tar = encoder.encode("tar bytes");
    const id = await host.add(tar);
    const prepared = createPreparedInstalls({
      fetch: host.fetch,
      origin: ORIGIN,
      index: {},
      retryDelayMs: 0,
    });
    expect(await prepared.archive({ id: "e".repeat(64), size: 1 })).toBeNull();
    host.status.set(id, [503]);
    expect(await prepared.archive({ id, size: tar.length })).toEqual({ bytes: tar, cached: false });
    host.objects.set(id, encoder.encode("other bytes"));
    expect(await prepared.archive({ id, size: tar.length })).toBeNull();
  });

  it("keeps what it fetched and reads it back, checked", async () => {
    const host = createObjectHost();
    const memory = createMemoryCache();
    const tar = encoder.encode("tar bytes");
    const id = await host.add(tar);
    const prepared = createPreparedInstalls({
      fetch: host.fetch,
      origin: ORIGIN,
      index: {},
      cache: memory.cache,
    });
    expect(await prepared.archive({ id, size: tar.length })).toEqual({ bytes: tar, cached: false });
    await prepared.stored();
    expect(memory.store.get(`${ORIGIN}${depsObjectPath(id)}`)).toEqual(tar);
    expect(await prepared.archive({ id, size: tar.length })).toEqual({ bytes: tar, cached: true });
    expect(host.requests).toHaveLength(1);
  });

  it("drops a planted object from the cache and fetches the real one", async () => {
    const host = createObjectHost();
    const memory = createMemoryCache();
    const tar = encoder.encode("tar bytes");
    const id = await host.add(tar);
    const url = `${ORIGIN}${depsObjectPath(id)}`;
    memory.store.set(url, encoder.encode("planted"));
    const prepared = createPreparedInstalls({
      fetch: host.fetch,
      origin: ORIGIN,
      index: {},
      cache: memory.cache,
    });
    expect(await prepared.archive({ id, size: tar.length })).toEqual({ bytes: tar, cached: false });
    expect(memory.deleted).toEqual([url]);
    await prepared.stored();
    expect(memory.store.get(url)).toEqual(tar);
  });

  it("stores nothing that failed its check", async () => {
    const host = createObjectHost();
    const memory = createMemoryCache();
    const id = await host.add(encoder.encode("tar bytes"));
    host.objects.set(id, encoder.encode("other bytes"));
    const prepared = createPreparedInstalls({
      fetch: host.fetch,
      origin: ORIGIN,
      index: {},
      cache: memory.cache,
    });
    expect(await prepared.archive({ id, size: 9 })).toBeNull();
    await prepared.stored();
    expect(memory.store.size).toBe(0);
  });
});
