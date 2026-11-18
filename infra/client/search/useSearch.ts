import {
  keepPreviousData,
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { primeLessonDetails, searchKeys } from "../../lessons/queryKeys";
import { mergeSearchPages, search, type SearchPage } from "./searchApi";

/** Module-level, so the merged answer is recomputed only when the pages change. */
const selectResults = (data: InfiniteData<SearchPage, number>) => mergeSearchPages(data.pages);

// Searches every published lesson, public playlist and author, not just what
// the gallery has paged in. `q` is a query the reader submitted, not each
// keystroke. `data` is every page loaded so far, merged; fetchNextPage loads
// the next page of lessons (see infra/worker/routes/search.ts).
export function useSearch(q: string) {
  const queryClient = useQueryClient();

  return useInfiniteQuery({
    queryKey: searchKeys.query(q),
    queryFn: async ({ pageParam }) => {
      const page = await search(q, pageParam);
      // Each result is the same whole lesson /api/lessons/:slug returns, so
      // opening one resolves from cache.
      primeLessonDetails(queryClient, page.lessons);
      return page;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextPage,
    select: selectResults,
    enabled: q.length > 0,
    staleTime: 30_000,
    // While the next search loads, the last one's results stay (isPlaceholderData),
    // so the page dims them instead of blanking.
    placeholderData: keepPreviousData,
  });
}
