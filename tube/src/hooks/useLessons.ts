import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { FIRST_LESSONS_PAGE } from "../../../infra/lessons/lessonsPages";
import { lessonKeys, primeLessonDetails } from "../../../infra/lessons/queryKeys";
import { fetchLessonsPage, findLessonBySlug } from "../lib/lessons";

// Paginated lesson gallery: D1-backed user-published lessons newest first, with
// the bundled seed appended to the last page (see lib/lessons.ts). Overrides the queryClient-wide
// staleTime: Infinity default (tuned for the build-static seed alone) with a
// finite one here, since the D1 portion is live data other users publish to —
// without this, a tab left open would never see newly published lessons.
//
// Shared with the /learn route loader (src/router.tsx), which prefetches page 0
// while the route chunk is still loading. Both must build the same query, or
// the grid would fetch page 0 a second time. A direct visit usually needs
// neither fetch: the Worker dehydrates page 0 into the document
// (infra/worker/ssr/learnGallery.ts), so the query starts fresh.
export function lessonsInfiniteQueryOptions(queryClient: QueryClient) {
  return infiniteQueryOptions({
    queryKey: lessonKeys.infinite,
    queryFn: async ({ pageParam }) => {
      const page = await fetchLessonsPage(pageParam);
      primeLessonDetails(queryClient, page.lessons);
      return page;
    },
    initialPageParam: FIRST_LESSONS_PAGE,
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
// (primed by primeLessonDetails), and a direct visit to a URL the Worker
// server-rendered (dehydrated into the cache before the first render — see
// hydrateServerQueryState in src/queryClient.ts). The fetch below is the
// fallback for everything else.
export function useLesson(slug: string | undefined) {
  return useQuery({
    queryKey: lessonKeys.detail(slug),
    queryFn: () => findLessonBySlug(slug!),
    enabled: !!slug,
    staleTime: 60_000,
  });
}
