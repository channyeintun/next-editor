import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { fetchLessonsPage, findLessonBySlug } from "../lib/lessons";
import type { Lesson } from "../types";

/** Also produced by the edge render (infra/worker/ssr/lessonDetail.ts) — the two must match. */
export function lessonDetailQueryKey(slug: string | undefined) {
  return ["lessons", "detail", slug] as const;
}

/**
 * Seed the detail cache from a list that already carries whole Lesson objects.
 * Every card in the gallery or a playlist holds exactly what the detail route
 * asks for, so clicking one should resolve from cache rather than re-fetching
 * the row the list just downloaded. Called from the list query functions (not
 * during render) so it covers every card without per-card wiring.
 */
export function primeLessonDetails(queryClient: QueryClient, lessons: readonly Lesson[]): void {
  for (const lesson of lessons) {
    queryClient.setQueryData(lessonDetailQueryKey(lesson.slug), lesson);
  }
}

// Paginated lesson gallery: D1-backed user-published lessons newest first, with
// the bundled seed appended to the last page (see lib/lessons.ts). Overrides the queryClient-wide
// staleTime: Infinity default (tuned for the build-static seed alone) with a
// finite one here, since the D1 portion is live data other users publish to —
// without this, a tab left open would never see newly published lessons.
//
// Shared with the /learn route loader (src/router.tsx), which prefetches page 0
// while the route chunk is still loading. Both must build the same query, or
// the grid would fetch page 0 a second time.
export function lessonsInfiniteQueryOptions(queryClient: QueryClient) {
  return infiniteQueryOptions({
    queryKey: ["lessons", "infinite"],
    queryFn: async ({ pageParam }) => {
      const page = await fetchLessonsPage(pageParam);
      primeLessonDetails(queryClient, page.lessons);
      return page;
    },
    initialPageParam: "d1:0",
    getNextPageParam: (lastPage) => lastPage.nextPage,
    staleTime: 60_000,
  });
}

export function useLessonsInfinite() {
  const queryClient = useQueryClient();

  return useInfiniteQuery(lessonsInfiniteQueryOptions(queryClient));
}

// Single lesson by slug for the detail route. `data` is the lesson, or null
// when the slug doesn't match any lesson (vs. isError for a fetch failure).
// Same live-data override as useLessonsInfinite above.
//
// Two paths keep this from fetching at all: an in-app navigation from a list
// (primed above), and a direct visit to a URL the Worker server-rendered
// (dehydrated into the cache before the first render — see
// hydrateServerQueryState in src/queryClient.ts). The fetch below is the
// fallback for everything else.
export function useLesson(slug: string | undefined) {
  return useQuery({
    queryKey: lessonDetailQueryKey(slug),
    queryFn: () => findLessonBySlug(slug!),
    enabled: !!slug,
    staleTime: 60_000,
  });
}
