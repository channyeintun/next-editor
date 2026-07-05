import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { fetchLessonsPage, findLessonBySlug } from "../lib/lessons";

// Paginated lesson gallery: the static seed first, then D1-backed
// user-published lessons (see lib/lessons.ts). Overrides the queryClient-wide
// staleTime: Infinity default (tuned for the build-static seed alone) with a
// finite one here, since the D1 portion is live data other users publish to —
// without this, a tab left open would never see newly published lessons.
export function useLessonsInfinite() {
  return useInfiniteQuery({
    queryKey: ["lessons", "infinite"],
    queryFn: ({ pageParam }) => fetchLessonsPage(pageParam),
    initialPageParam: "seed:0",
    getNextPageParam: (lastPage) => lastPage.nextPage,
    staleTime: 60_000,
  });
}

// Single lesson by slug for the detail route. `data` is the lesson, or null
// when the slug doesn't match any lesson (vs. isError for a fetch failure).
// Same live-data override as useLessonsInfinite above.
export function useLesson(slug: string | undefined) {
  return useQuery({
    queryKey: ["lessons", "detail", slug],
    queryFn: () => findLessonBySlug(slug!),
    enabled: !!slug,
    staleTime: 60_000,
  });
}
