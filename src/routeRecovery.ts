import { lazy } from "react";
import type { ComponentType, LazyExoticComponent } from "react";

// Stale-chunk recovery for every lazily imported chunk: the router's lazy
// routes and the panels they load later (lazyWithRecovery). After a deploy, a
// cached page can ask for chunk names that no longer exist; each route and
// each panel then gets one automatic reload, which refetches the HTML and the
// current chunk names.

const DYNAMIC_IMPORT_RECOVERY_PARAM = "__route_reload";
// Vite's preload helper rejects with "Unable to preload CSS for <url>" when a
// chunk's stylesheet is missing, before it even imports the JS.
const DYNAMIC_IMPORT_ERROR_PATTERN =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;
const ROUTE_RELOAD_STORAGE_PREFIX = "next-editor:route-reload:";

function normalizeRoutePath(routePath: string) {
  if (routePath === "/") {
    return routePath;
  }

  return routePath.replace(/\/+$/, "");
}

// Keyed by the route's pattern ("/learn/:slug"), not the URL, so each route gets
// one automatic reload however many lessons fail to load behind it.
function getRouteReloadStorageKey(routePath: string) {
  return `${ROUTE_RELOAD_STORAGE_PREFIX}${normalizeRoutePath(routePath)}`;
}

// Reading `window.sessionStorage` throws where the browser denies the document
// storage (site data blocked, or third-party storage blocked for an embedded
// lesson). The reload marker is best-effort: blocked storage only costs the
// one-shot automatic reload, never a route whose chunk loaded.
function withSessionStorage<T>(use: (storage: Storage) => T, fallback: T): T {
  try {
    return use(window.sessionStorage);
  } catch {
    return fallback;
  }
}

function hasRouteReloaded(routePath: string) {
  return withSessionStorage(
    (storage) => storage.getItem(getRouteReloadStorageKey(routePath)) === "1",
    true,
  );
}

// False when the marker could not be stored: a reload that cannot be recorded
// would repeat forever on a chunk that stays missing, so the route shows its
// error boundary instead.
function markRouteReloaded(routePath: string) {
  return withSessionStorage((storage) => {
    storage.setItem(getRouteReloadStorageKey(routePath), "1");
    return true;
  }, false);
}

function clearRouteReload(routePath: string) {
  withSessionStorage(
    (storage) => storage.removeItem(getRouteReloadStorageKey(routePath)),
    undefined,
  );
}

// The error boundary knows the URL but not the pattern it matched, so a manual
// reload re-arms the automatic one for every route.
export function clearAllRouteReloads() {
  withSessionStorage((storage) => {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(ROUTE_RELOAD_STORAGE_PREFIX)) {
        storage.removeItem(key);
      }
    }
  }, undefined);
}

// A fresh query string makes the browser refetch the HTML, and with it the
// current chunk names.
export function reloadWithRecoveryParam() {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set(DYNAMIC_IMPORT_RECOVERY_PARAM, Date.now().toString());
  window.location.replace(nextUrl.toString());
}

function clearRecoverySearchParam() {
  if (typeof window === "undefined") {
    return;
  }

  const nextUrl = new URL(window.location.href);

  if (!nextUrl.searchParams.has(DYNAMIC_IMPORT_RECOVERY_PARAM)) {
    return;
  }

  nextUrl.searchParams.delete(DYNAMIC_IMPORT_RECOVERY_PARAM);
  window.history.replaceState(window.history.state, "", nextUrl.toString());
}

export function isDynamicImportError(error: unknown) {
  if (error instanceof Error) {
    return DYNAMIC_IMPORT_ERROR_PATTERN.test(error.message);
  }

  if (typeof error === "string") {
    return DYNAMIC_IMPORT_ERROR_PATTERN.test(error);
  }

  return false;
}

// One import with the stale-chunk rule: success re-arms the automatic reload,
// a stale chunk spends it (keyed by `recoveryKey`), anything else rethrows.
async function importWithRecovery<T>(importer: () => Promise<T>, recoveryKey: string): Promise<T> {
  try {
    const module = await importer();
    clearRouteReload(recoveryKey);
    clearRecoverySearchParam();
    return module;
  } catch (error) {
    if (
      typeof window !== "undefined" &&
      isDynamicImportError(error) &&
      !hasRouteReloaded(recoveryKey) &&
      markRouteReloaded(recoveryKey)
    ) {
      reloadWithRecoveryParam();

      return new Promise<never>(() => {});
    }

    throw error;
  }
}

export function lazyRoute(importer: () => Promise<{ default: ComponentType }>, routePath: string) {
  return async () => {
    const module = await importWithRecovery(importer, routePath);
    return { Component: module.default };
  };
}

/**
 * React.lazy with the routes' stale-chunk recovery, for chunks a route loads
 * after it renders (CodeEditor, panels, dialogs). Without it, a stale panel
 * chunk reaches the route's error boundary and waits for a manual reload.
 * `chunkName` keys the one automatic reload, separately from the routes'.
 */
export function lazyWithRecovery<P>(
  importer: () => Promise<{ default: ComponentType<P> }>,
  chunkName: string,
): LazyExoticComponent<ComponentType<P>> {
  return lazy(() => importWithRecovery(importer, `chunk:${chunkName}`));
}
