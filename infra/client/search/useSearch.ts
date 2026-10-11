import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { primeLessonDetails, searchKeys } from "../../lessons/queryKeys";
import { search } from "./searchApi";

// Searches every published lesson and every author, not just what the
// gallery has paged in. `q` is a query the reader submitted, not each keystroke.
export function useSearch(q: string) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: searchKeys.query(q),
    queryFn: async () => {
      const results = await search(q);
      // Each result is the same whole lesson /api/lessons/:slug returns, so
      // opening one resolves from cache.
      primeLessonDetails(queryClient, results.lessons);
      return results;
    },
    enabled: q.length > 0,
    staleTime: 30_000,
    // While the next search loads, the last one's results stay (isPlaceholderData),
    // so the page dims them instead of blanking.
    placeholderData: keepPreviousData,
  });
}
