import { hydrate, QueryClient } from "@tanstack/react-query";

// Most application queries invalidate explicitly after mutations. Individual
// volatile queries (auth/search/playlist membership) override this session cache.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      gcTime: Infinity,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/** Kept in sync with infra/worker/ssr/lessonDetail.ts. */
const SERVER_QUERY_STATE_ELEMENT_ID = "__NE_QUERY_STATE__";

/**
 * Adopt the cache the edge already filled. A direct visit to a server-rendered
 * route (currently /learn/:slug) ships the resolved row dehydrated in the
 * document, so the matching useQuery starts in `success` with no fetch at all
 * — the request the server already made is not repeated in the browser.
 *
 * Must run before the first render, and stays best-effort: a missing or
 * malformed payload just means the app fetches for itself, as it always did.
 */
export function hydrateServerQueryState(): void {
  const element = document.getElementById(SERVER_QUERY_STATE_ELEMENT_ID);
  if (!element?.textContent) {
    return;
  }

  try {
    hydrate(queryClient, JSON.parse(element.textContent));
  } catch (error) {
    console.error("Failed to hydrate server query state", error);
  }
}
