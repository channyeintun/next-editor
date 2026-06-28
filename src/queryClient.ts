import { QueryClient } from "@tanstack/react-query";

// App data (the lessons manifest today) is build-static, so cache it for the
// whole session and never auto-refetch. Error retries stay modest.
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
