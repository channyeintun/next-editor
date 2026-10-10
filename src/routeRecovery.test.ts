import { act, render, screen } from "@testing-library/react";
import { Component, createElement, Suspense } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  clearAllRouteReloads,
  isDynamicImportError,
  lazyRoute,
  lazyWithRecovery,
} from "./routeRecovery";

const ROUTE_KEY = "next-editor:route-reload:/learn/:slug";
const PANEL_KEY = "next-editor:route-reload:chunk:SlidesManager";

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

describe("isDynamicImportError", () => {
  it("recognises a chunk whose stylesheet failed to preload", () => {
    expect(
      isDynamicImportError(new Error("Unable to preload CSS for /assets/Editor-abc123.css")),
    ).toBe(true);
  });
});

class CaughtError extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  render() {
    return this.state.message === null
      ? this.props.children
      : createElement("p", null, `caught: ${this.state.message}`);
  }
}

function Panel({ label }: { label: string }) {
  return createElement("p", null, label);
}

async function renderLazyPanel(load: () => Promise<{ default: typeof Panel }>) {
  const LazyPanel = lazyWithRecovery(load, "SlidesManager");
  await act(async () => {
    render(
      createElement(
        CaughtError,
        null,
        createElement(
          Suspense,
          { fallback: createElement("p", null, "loading") },
          createElement(LazyPanel, { label: "slides" }),
        ),
      ),
    );
  });
}

describe("lazyWithRecovery", () => {
  it("renders the chunk's component and clears the chunk's reload marker", async () => {
    window.sessionStorage.setItem(PANEL_KEY, "1");

    await renderLazyPanel(async () => ({ default: Panel }));

    expect(screen.getByText("slides")).toBeTruthy();
    expect(window.sessionStorage.getItem(PANEL_KEY)).toBeNull();
  });

  it("reloads once for a stale chunk and stays suspended meanwhile", async () => {
    await renderLazyPanel(() => Promise.reject(staleChunkError()));

    expect(screen.getByText("loading")).toBeTruthy();
    expect(window.sessionStorage.getItem(PANEL_KEY)).toBe("1");
    expect(window.sessionStorage.getItem(ROUTE_KEY)).toBeNull();
  });

  it("hands a stale chunk to the error boundary once the reload is spent", async () => {
    window.sessionStorage.setItem(PANEL_KEY, "1");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await renderLazyPanel(() => Promise.reject(staleChunkError()));

    expect(screen.getByText(/caught: Failed to fetch dynamically imported module/)).toBeTruthy();
    consoleError.mockRestore();
  });

  it("hands other import errors straight to the error boundary", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await renderLazyPanel(() => Promise.reject(new Error("module threw")));

    expect(screen.getByText("caught: module threw")).toBeTruthy();
    expect(window.sessionStorage.getItem(PANEL_KEY)).toBeNull();
    consoleError.mockRestore();
  });
});

describe("clearAllRouteReloads", () => {
  it("re-arms every route's and chunk's reload and leaves other session keys alone", () => {
    window.sessionStorage.setItem(ROUTE_KEY, "1");
    window.sessionStorage.setItem("next-editor:route-reload:/code", "1");
    window.sessionStorage.setItem(PANEL_KEY, "1");
    window.sessionStorage.setItem("unrelated", "kept");

    clearAllRouteReloads();

    expect(window.sessionStorage.getItem(ROUTE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem("next-editor:route-reload:/code")).toBeNull();
    expect(window.sessionStorage.getItem(PANEL_KEY)).toBeNull();
    expect(window.sessionStorage.getItem("unrelated")).toBe("kept");
  });

  it("does nothing when session storage is blocked", () => {
    unblockStorage = blockStorage();

    expect(() => clearAllRouteReloads()).not.toThrow();
  });
});
