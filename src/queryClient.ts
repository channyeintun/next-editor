import { QueryClient } from "@tanstack/react-query";

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
