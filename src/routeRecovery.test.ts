import { afterEach, describe, expect, it } from "vite-plus/test";
import { clearAllRouteReloads, lazyRoute } from "./routeRecovery";

const ROUTE_KEY = "next-editor:route-reload:/learn/:slug";

function Page() {
  return null;
}

function staleChunkError() {
  return new TypeError("Failed to fetch dynamically imported module: /assets/Page-abc123.js");
}

// Reading `window.sessionStorage` throws where the browser denies the document
// storage: site data blocked, or third-party storage blocked for an embedded
// lesson.
function blockStorage(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(window, "sessionStorage");
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    get() {
      throw new DOMException("Access is denied for this document.", "SecurityError");
    },
  });
  return () => {
    if (descriptor) Object.defineProperty(window, "sessionStorage", descriptor);
  };
}

// lazyRoute's reload never settles; a sentinel that does tells the two apart.
async function settlesNow(promise: Promise<unknown>) {
  const pending = Symbol("pending");
  const result = await Promise.race([
    promise.then(
      () => "settled",
      () => "settled",
    ),
    new Promise((resolve) => setTimeout(() => resolve(pending), 0)),
  ]);
  return result !== pending;
}

let unblockStorage: (() => void) | null = null;

afterEach(() => {
  unblockStorage?.();
  unblockStorage = null;
  window.sessionStorage.clear();
});

describe("lazyRoute", () => {
  it("resolves the route component and clears the route's reload marker", async () => {
    window.sessionStorage.setItem(ROUTE_KEY, "1");

    await expect(lazyRoute(async () => ({ default: Page }), "/learn/:slug/")()).resolves.toEqual({
      Component: Page,
    });
    expect(window.sessionStorage.getItem(ROUTE_KEY)).toBeNull();
  });

  it("resolves the route component when session storage is blocked", async () => {
    unblockStorage = blockStorage();

    await expect(lazyRoute(async () => ({ default: Page }), "/learn/:slug")()).resolves.toEqual({
      Component: Page,
    });
  });

  it("reloads once for a stale chunk, then rethrows the next failure", async () => {
    const load = lazyRoute(() => Promise.reject(staleChunkError()), "/learn/:slug");

    expect(await settlesNow(load())).toBe(false);
    expect(window.sessionStorage.getItem(ROUTE_KEY)).toBe("1");

    await expect(load()).rejects.toThrow("Failed to fetch dynamically imported module");
  });

  it("rethrows a stale chunk instead of reloading when storage cannot mark the route", async () => {
    unblockStorage = blockStorage();
    const load = lazyRoute(() => Promise.reject(staleChunkError()), "/learn/:slug");

    await expect(load()).rejects.toThrow("Failed to fetch dynamically imported module");
  });

  it("rethrows errors that are not stale chunks", async () => {
    const load = lazyRoute(() => Promise.reject(new Error("render failed")), "/learn/:slug");

    await expect(load()).rejects.toThrow("render failed");
    expect(window.sessionStorage.getItem(ROUTE_KEY)).toBeNull();
  });
});

describe("clearAllRouteReloads", () => {
  it("re-arms every route's reload and leaves other session keys alone", () => {
    window.sessionStorage.setItem(ROUTE_KEY, "1");
    window.sessionStorage.setItem("next-editor:route-reload:/code", "1");
    window.sessionStorage.setItem("unrelated", "kept");

    clearAllRouteReloads();

    expect(window.sessionStorage.getItem(ROUTE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem("next-editor:route-reload:/code")).toBeNull();
    expect(window.sessionStorage.getItem("unrelated")).toBe("kept");
  });

  it("does nothing when session storage is blocked", () => {
    unblockStorage = blockStorage();

    expect(() => clearAllRouteReloads()).not.toThrow();
  });
});
