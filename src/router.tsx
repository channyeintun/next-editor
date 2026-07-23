import { useEffect, type ComponentType } from "react";
import { createBrowserRouter, isRouteErrorResponse, useParams, useRouteError } from "react-router";
import { usePostHog } from "@posthog/react";
import Breadcrumb from "./components/Breadcrumb";
import EditorShellSkeleton from "./components/EditorShellSkeleton";
import LessonGallerySkeleton from "./components/LessonGallerySkeleton";
import LoadingSpinner from "./components/LoadingSpinner";
import LandingPageRoute from "./components/LandingPageRoute";
import { lessonTitleFromSlug } from "./utils/lessonSlug";

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
  const posthog = usePostHog();
  const dynamicImportError = isDynamicImportError(error);

  // In an effect, not during render: StrictMode double-invokes render and any
  // re-render of the boundary would re-report the same error.
  useEffect(() => {
    if (!dynamicImportError) {
      posthog?.captureException(error);
    }
  }, [error, dynamicImportError, posthog]);

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
    <div className="h-dvh flex items-center justify-center bg-[#11141c] text-white">
      <LoadingSpinner />
    </div>
  );
}

// Editor-shaped routes get the editor shell instead: their chunk carries the
// whole chrome (header, file tree, Monaco), so a bare spinner is the only thing
// on screen for the entire download. The skeleton is eager-bundle-safe — plain
// markup, no providers — so it paints as soon as the app boots.
function EditorRouteHydrateFallback() {
  return <EditorShellSkeleton showPlayerBar />;
}

// /learn/:slug serves both lesson detail and author profiles (see
// LearnSlugRoute); only the former is an editor. The slug is already in the URL,
// so the breadcrumb can name the lesson before anything has been fetched.
function LearnSlugHydrateFallback() {
  const { slug } = useParams();

  if (slug?.startsWith("@")) {
    return <RouteHydrateFallback />;
  }

  const placeholderTitle = lessonTitleFromSlug(slug);
  return (
    <EditorShellSkeleton
      breadcrumb={placeholderTitle ? <Breadcrumb title={placeholderTitle} /> : undefined}
      showPlayerBar
    />
  );
}

export const router = createBrowserRouter([
  {
    path: "/",
    // The landing route is eager so its first client render exactly matches the
    // HTML emitted by the edge renderer. Application-heavy routes remain lazy.
    Component: LandingPageRoute,
    ErrorBoundary: RouteErrorBoundary,
  },
  {
    path: "/code",
    lazy: lazyRoute(() => import("./components/CodeRoute"), "/code"),
    HydrateFallback: EditorRouteHydrateFallback,
    ErrorBoundary: RouteErrorBoundary,
  },
  {
    path: "/architecture",
    lazy: lazyRoute(() => import("./components/ArchitecturePage"), "/architecture"),
    HydrateFallback: RouteHydrateFallback,
    ErrorBoundary: RouteErrorBoundary,
  },
  // Lesson production studio (docs/agent-lesson-production.md): pick a
  // LessonScript (or import one) and render it into a lesson entirely
  // client-side. Lazy like the other app-heavy routes; rendering needs no
  // server beyond the standard app APIs (drafts still require sign-in).
  {
    path: "/studio",
    lazy: lazyRoute(() => import("./studio/StudioRoute"), "/studio"),
    HydrateFallback: RouteHydrateFallback,
    ErrorBoundary: RouteErrorBoundary,
  },
  {
    path: "/learn",
    lazy: lazyRoute(() => import("@next-editor/tube"), "/learn"),
    HydrateFallback: LessonGallerySkeleton,
    ErrorBoundary: RouteErrorBoundary,
  },
  {
    // A different path depth than /learn/:slug below, so it's just an
    // ordinary distinct route — no @-prefix-style disambiguation needed
    // (that trick in LearnSlugRoute only exists because /learn/@username and
    // /learn/some-slug collide on the same single path segment).
    path: "/learn/playlist/:slug",
    lazy: lazyRoute(
      () => import("@next-editor/tube").then((m) => ({ default: m.PlaylistDetailRoute })),
      "/learn/playlist/:slug",
    ),
    // Same shell: a playlist is a navbar plus a shelf of lesson cards.
    HydrateFallback: LessonGallerySkeleton,
    ErrorBoundary: RouteErrorBoundary,
  },
  {
    // Handles both lesson detail (/learn/some-title-abc12345) and author
    // profiles (/learn/@username) — see LearnSlugRoute for why these can't
    // be split into two router-level routes.
    path: "/learn/:slug",
    lazy: lazyRoute(
      () => import("@next-editor/tube").then((m) => ({ default: m.LearnSlugRoute })),
      "/learn/:slug",
    ),
    HydrateFallback: LearnSlugHydrateFallback,
    ErrorBoundary: RouteErrorBoundary,
  },
]);
