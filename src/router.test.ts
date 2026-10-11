import type { LoaderFunctionArgs } from "react-router";
import { afterAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { prefetchLearnSlugRouteView, router } from "./router";
import { deferAnalyticsUntil } from "./utils/analytics";

vi.mock("./utils/analytics", () => ({
  analytics: { captureException: vi.fn<(error: unknown) => void>() },
  deferAnalyticsUntil: vi.fn<(work: Promise<unknown>) => void>(),
}));

vi.mock("./components/CodeEditor", () => ({ default: () => null }));

vi.mock("../tube/src/lessonRouteLoaders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tube/src/lessonRouteLoaders")>()),
  loadLearnSlugRoute: vi.fn<() => Promise<{ default: () => null }>>(async () => ({
    default: () => null,
  })),
  prefetchLearnSlugView: vi.fn<(slug: string | undefined) => void>(),
}));

function loaderArgs(slug: string): LoaderFunctionArgs {
  return { params: { slug } } as unknown as LoaderFunctionArgs;
}

beforeEach(() => {
  vi.mocked(deferAnalyticsUntil).mockClear();
});

afterAll(() => {
  router.dispose();
});

// An author profile renders no editor, so it must neither download Monaco nor
// hold PostHog back for it. Only the loader sees the slug, so it decides.
describe("/learn/:slug CodeEditor prefetch", () => {
  it("starts the CodeEditor import for a lesson", () => {
    prefetchLearnSlugRouteView(loaderArgs("intro-to-rust"));
    expect(deferAnalyticsUntil).toHaveBeenCalledTimes(1);
  });

  it("does not start it for an author profile", () => {
    prefetchLearnSlugRouteView(loaderArgs("@alice"));
    expect(deferAnalyticsUntil).not.toHaveBeenCalled();
  });

  it("does not start it from the route's lazy(), which every profile runs too", async () => {
    const route = router.routes.find((candidate) => candidate.path === "/learn/:slug");
    const lazy = route?.lazy;
    if (typeof lazy !== "function") throw new Error("/learn/:slug has no lazy() function");

    await lazy();
    expect(deferAnalyticsUntil).not.toHaveBeenCalled();
  });
});
