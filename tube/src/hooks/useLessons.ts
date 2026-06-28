import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { fetchLessonsPage, findLessonBySlug } from "../lib/lessons";

// Paginated lesson gallery. Caching/dedup/staleness are owned by TanStack Query
// (see queryClient defaults: staleTime Infinity — the manifest is build-static).
export function useLessonsInfinite() {
  return useInfiniteQuery({
    queryKey: ["lessons", "infinite"],
    queryFn: ({ pageParam }) => fetchLessonsPage(pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextPage,
  });
}

// Single lesson by slug for the detail route. `data` is the lesson, or null
// when the slug doesn't match any lesson (vs. isError for a fetch failure).
export function useLesson(slug: string | undefined) {
  return useQuery({
    queryKey: ["lessons", "detail", slug],
    queryFn: () => findLessonBySlug(slug!),
    enabled: !!slug,
  });
}
