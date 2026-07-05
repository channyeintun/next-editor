import axios from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../apiClient";
import type { AuthUser } from "../../db/types";

const ME_QUERY_KEY = ["auth", "me"] as const;

// null (not undefined — Query rejects undefined) when signed out, so callers
// can tell "not signed in" from a real fetch failure.
async function fetchMe(): Promise<AuthUser | null> {
  try {
    const res = await apiClient.get<{ user: AuthUser }>("/auth/me");
    return res.data.user;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 401) return null;
    throw err;
  }
}

// No dedicated Provider/Context — TanStack Query's shared cache (see
// queryClient.ts) already gives every caller of useAuth() the same session
// state, the same way tube's useLessonsInfinite/useLesson work.
export function useAuth(options: { enabled?: boolean } = {}) {
  const query = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: fetchMe,
    staleTime: 60_000,
    enabled: options.enabled ?? true,
  });
  return {
    user: query.data ?? null,
    isSignedIn: !!query.data,
    isLoading: query.isPending,
  };
}

export function useSignOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await apiClient.post("/auth/logout");
    },
    onSuccess: () => {
      queryClient.setQueryData(ME_QUERY_KEY, null);
    },
  });
}

// A real browser navigation, not a fetch — /api/auth/google/login is a
// server-driven 302 redirect to Google, which only works as a top-level
// document navigation (an XHR would just follow it invisibly and get stuck
// on Google's login HTML).
export function signInUrl(returnTo?: string): string {
  const url = new URL("/api/auth/google/login", window.location.origin);
  if (returnTo) {
    url.searchParams.set("returnTo", returnTo);
  }
  return url.toString();
}
