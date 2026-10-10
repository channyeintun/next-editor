import { useEffect } from "react";
import {
  createBrowserRouter,
  isRouteErrorResponse,
  useParams,
  useRouteError,
  type LoaderFunctionArgs,
} from "react-router";
import EditorShellSkeleton from "./components/EditorShellSkeleton";
import LessonGallerySkeleton from "./components/LessonGallerySkeleton";
import LessonPageSkeleton from "./components/LessonPageSkeleton";
import PageLoadingSpinner from "./components/PageLoadingSpinner";
import LandingPageRoute from "./components/LandingPageRoute";
import {
  isAuthorProfileSlug,
  loadLearnSlugRoute,
  prefetchLearnSlugView,
} from "../tube/src/lessonRouteLoaders";
import { queryClient } from "./queryClient";
import {
  clearAllRouteReloads,
  isDynamicImportError,
  lazyRoute,
  reloadWithRecoveryParam,
} from "./routeRecovery";
import { analytics, deferAnalyticsUntil } from "./utils/analytics";

function getRouteErrorMessage(error: unknown) {
  if (isRouteErrorResponse(error)) {
    return error.statusText || "The route could not be loaded.";
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "The route could not be loaded.";
}

// Editor lazy-loads CodeEditor, and Monaco with it, so the shell can paint and
// fetch the lesson without waiting for Monaco. Routes that render the Editor
// start that import alongside their own chunk, so Monaco still downloads from
// the start of the navigation, in parallel. A failed fetch is left to Editor's
// own lazy import, which reports it. PostHog waits for that chunk (Monaco text
// is these routes' LCP) instead of taking a share of its download.
function withCodeEditorPrefetch<T>(importer: () => Promise<T>) {
  return () => {
    deferAnalyticsUntil(import("./components/CodeEditor"));
    return importer();
  };
}

// The gallery's page 0 would otherwise be requested only once LessonGrid
// mounts, after the whole route chunk has loaded and rendered. React Router runs
// a route's loader alongside its lazy(), so this starts the request in parallel.
// It returns at once: the navigation never waits on data. The grid's query has
// the same options, so it adopts this request, in flight or done, rather than
// repeating it; a failure here leaves the grid to fetch for itself. PostHog
// waits for the first row of thumbnails, the gallery's LCP.
function prefetchLessonGallery() {
  import("../tube/src/hooks/useLessons")
    .then(({ lessonsInfiniteQueryOptions }) =>
      queryClient.prefetchInfiniteQuery(lessonsInfiniteQueryOptions(queryClient)),
    )
    .catch(() => {});
  deferAnalyticsUntil(
    import("../tube/src/lib/firstRowThumbnails").then((thumbnails) =>
      thumbnails.whenFirstRowThumbnailsSettled(),
    ),
  );
  return null;
}

// /learn/:slug renders a lesson or an author profile, each behind its own
// chunk (see LearnSlugRoute). A route's lazy() can't see the slug, but its
// loader can, and runs alongside it, so this starts the right view's chunk in
// the same batch as the route's. Like prefetchLessonGallery, it returns at once.
function prefetchLearnSlugRouteView({ params }: LoaderFunctionArgs) {
  prefetchLearnSlugView(params.slug);
  return null;
}

function RouteErrorBoundary() {
  const error = useRouteError();
  const dynamicImportError = isDynamicImportError(error);

  // In an effect, not during render: StrictMode double-invokes render and any
  // re-render of the boundary would re-report the same error.
  useEffect(() => {
    if (!dynamicImportError) {
      analytics.captureException(error);
    }
  }, [error, dynamicImportError]);

  const title = dynamicImportError ? "App update required" : "Unexpected application error";
  const description = dynamicImportError
    ? "A cached page tried to load an outdated JavaScript chunk. Reloading fetches the current bundle."
    : "This route could not be rendered.";

  const handleReload = () => {
    clearAllRouteReloads();
    reloadWithRecoveryParam();
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
  return <PageLoadingSpinner />;
}

// Editor-shaped routes get the editor shell instead: their chunk carries the
// whole chrome (header, file tree, Monaco), so a bare spinner is the only thing
// on screen for the entire download. The skeleton is eager-bundle-safe — plain
// markup, no providers — so it paints as soon as the app boots.
function EditorRouteHydrateFallback() {
  return <EditorShellSkeleton showPlayerBar />;
}

// /learn/:slug serves both lesson detail and author profiles (see
// LearnSlugRoute); only the former is an editor.
function LearnSlugHydrateFallback() {
  const { slug } = useParams();

  if (isAuthorProfileSlug(slug)) {
    return <RouteHydrateFallback />;
  }

  return <LessonPageSkeleton slug={slug} />;
}

export const router = createBrowserRouter([
  {
    path: "/",
    // The landing route is eager so its first client render exactly matches the
    // HTML prerendered at build time. Application-heavy routes remain lazy.
    Component: LandingPageRoute,
    ErrorBoundary: RouteErrorBoundary,
  },
  {
    path: "/code",
    lazy: lazyRoute(
      withCodeEditorPrefetch(() => import("./components/CodeRoute")),
      "/code",
    ),
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
    lazy: lazyRoute(
      withCodeEditorPrefetch(() => import("./studio/StudioRoute")),
      "/studio",
    ),
    HydrateFallback: RouteHydrateFallback,
    ErrorBoundary: RouteErrorBoundary,
  },
  // The gallery routes import their own page modules, not the tube package's
  // barrel: that re-exports the lesson route too, and with it the lesson player
  // (Editor, collaboration, the recording codec), which the gallery's
  // thumbnails would then wait for. The gallery warms the lesson route once its
  // own thumbnails are in (see tube/src/lessonRouteLoaders.ts).
  {
    path: "/learn",
    loader: prefetchLessonGallery,
    lazy: lazyRoute(() => import("../tube/src/LearnPage"), "/learn"),
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
      () => import("../tube/src/components/PlaylistDetailRoute"),
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
    loader: prefetchLearnSlugRouteView,
    // Author profiles share this route and also start the CodeEditor import:
    // a route's lazy() can't see the slug.
    lazy: lazyRoute(withCodeEditorPrefetch(loadLearnSlugRoute), "/learn/:slug"),
    HydrateFallback: LearnSlugHydrateFallback,
    ErrorBoundary: RouteErrorBoundary,
  },
]);
