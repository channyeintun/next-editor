import { useQuery } from "@tanstack/react-query";
import { search } from "./searchApi";

// Searches every published lesson and every author, not just what the
// gallery has paged in. `q` should already be debounced by the caller.
export function useSearch(q: string) {
  return useQuery({
    queryKey: ["search", q],
    queryFn: () => search(q),
    enabled: q.length > 0,
    staleTime: 30_000,
  });
}
