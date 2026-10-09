import { useQuery, useQueryClient } from "@tanstack/react-query";
import { primeLessonDetails } from "../../lessons/queryKeys";
import { search } from "./searchApi";

// Searches every published lesson and every author, not just what the
// gallery has paged in. `q` should already be debounced by the caller.
export function useSearch(q: string) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: ["search", q],
    queryFn: async () => {
      const results = await search(q);
      // Each result is the same whole lesson /api/lessons/:slug returns, so
      // opening one resolves from cache.
      primeLessonDetails(queryClient, results.lessons);
      return results;
    },
    enabled: q.length > 0,
    staleTime: 30_000,
  });
}
