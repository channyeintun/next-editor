import type { ComponentType } from "react";
import { createBrowserRouter, isRouteErrorResponse, useRouteError } from "react-router-dom";

const DYNAMIC_IMPORT_RECOVERY_PARAM = "__route_reload";
const DYNAMIC_IMPORT_ERROR_PATTERN =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

function normalizeRoutePath(routePath: string) {
  if (routePath === "/") {
    return routePath;
  }

  return routePath.replace(/\/+$/, "");
}

function getRouteReloadStorageKey(routePath: string) {
  return `next-editor:route-reload:${normalizeRoutePath(routePath)}`;
}

function hasRouteReloaded(routePath: string) {
  return sessionStorage.getItem(getRouteReloadStorageKey(routePath)) === "1";
}

function markRouteReloaded(routePath: string) {
  sessionStorage.setItem(getRouteReloadStorageKey(routePath), "1");
}

function clearRouteReload(routePath: string) {
  sessionStorage.removeItem(getRouteReloadStorageKey(routePath));
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

function isDynamicImportError(error: unknown) {
  if (error instanceof Error) {
    return DYNAMIC_IMPORT_ERROR_PATTERN.test(error.message);
  }

  if (typeof error === "string") {
    return DYNAMIC_IMPORT_ERROR_PATTERN.test(error);
  }

  return false;
}

function getRouteErrorMessage(error: unknown) {
  if (isRouteErrorResponse(error)) {
    return error.statusText || "The route could not be loaded.";
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "The route could not be loaded.";
}

function lazyRoute(importer: () => Promise<{ default: ComponentType }>, routePath: string) {
  return async () => {
    try {
      const module = await importer();
      clearRouteReload(routePath);
      clearRecoverySearchParam();
      return { Component: module.default };
    } catch (error) {
      if (
        typeof window !== "undefined" &&
        isDynamicImportError(error) &&
        !hasRouteReloaded(routePath)
      ) {
        markRouteReloaded(routePath);

        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set(DYNAMIC_IMPORT_RECOVERY_PARAM, Date.now().toString());
        window.location.replace(nextUrl.toString());

        return new Promise<never>(() => {});
      }

      throw error;
    }
  };
}

function RouteErrorBoundary() {
  const error = useRouteError();
  const dynamicImportError = isDynamicImportError(error);

  const title = dynamicImportError ? "App update required" : "Unexpected application error";
  const description = dynamicImportError
    ? "A cached page tried to load an outdated JavaScript chunk. Reloading fetches the current bundle."
    : "This route could not be rendered.";

  const handleReload = () => {
    clearRouteReload(window.location.pathname);

    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set(DYNAMIC_IMPORT_RECOVERY_PARAM, Date.now().toString());
    window.location.replace(nextUrl.toString());
  };

  return (
    <div className="min-h-dvh flex items-center justify-center bg-slate-950 px-6 text-white">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-white/5 p-6 shadow-2xl backdrop-blur">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="mt-3 text-sm text-slate-300">{description}</p>
        <p className="mt-4 rounded-xl bg-black/20 px-4 py-3 text-sm text-slate-200 wrap-break-word">
          {getRouteErrorMessage(error)}
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-slate-950"
            onClick={handleReload}
            type="button"
          >
            Reload app
          </button>
          <a
            className="rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-slate-100"
            href="/"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

function RouteHydrateFallback() {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-slate-950 px-6 text-white">
      <div className="size-10 animate-spin rounded-full border-2 border-white/20 border-t-white" />
    </div>
  );
}

export const router = createBrowserRouter([
  {
    path: "/",
    lazy: lazyRoute(() => import("./components/LandingPage"), "/"),
    HydrateFallback: RouteHydrateFallback,
    ErrorBoundary: RouteErrorBoundary,
  },
  {
    path: "/code",
    lazy: lazyRoute(() => import("./components/Editor"), "/code"),
    HydrateFallback: RouteHydrateFallback,
    ErrorBoundary: RouteErrorBoundary,
  },
]);
