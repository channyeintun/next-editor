import axios from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../apiClient";
import type { AuthUser } from "../../db/types";
import { disableGoogleAutoSelect } from "./googleIdentity";

export const ME_QUERY_KEY = ["auth", "me"] as const;

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
      // Otherwise One Tap's automatic sign-in (GoogleOneTap.tsx) would put
      // the user straight back into a session on the next prompt.
      disableGoogleAutoSelect();
    },
  });
}

// Backs Google One Tap (GoogleOneTap.tsx): posts the GIS credential JWT to
// the JWKS-verified endpoint, which sets the same ne_session cookie as the
// redirect flow. Updates ME_QUERY_KEY directly so every useAuth() caller
// flips to signed-in without a round-trip.
export function useGoogleCredentialSignIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (credential: string) => {
      const res = await apiClient.post<{ user: AuthUser }>("/auth/google/onetap", { credential });
      return res.data.user;
    },
    onSuccess: (user) => {
      queryClient.setQueryData(ME_QUERY_KEY, user);
    },
  });
}

// Updates ME_QUERY_KEY directly from the response rather than invalidating,
// so every useAuth() caller (AuthMenu, AuthorProfilePage's own-profile
// check) sees the new username on the same render as the mutation succeeds,
// with no extra round-trip.
export function useUpdateUsername() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (username: string) => {
      const res = await apiClient.patch<{ user: AuthUser }>("/auth/username", { username });
      return res.data.user;
    },
    onSuccess: (user) => {
      queryClient.setQueryData(ME_QUERY_KEY, user);
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

// Google's avatar images (*.googleusercontent.com) send a
// Cross-Origin-Resource-Policy header that the app's COEP:require-corp
// blocks from a direct <img src> — the same problem the Google Slides
// import feature already solved. Reuses that same generic proxy route: in
// dev, tube/vite/proxyPlugin.ts already serves it directly; in production
// it's infra/worker/routes/proxy.ts.
export function avatarProxyUrl(avatarUrl: string): string {
  const url = new URL("/api/proxy", window.location.origin);
  url.searchParams.set("url", avatarUrl);
  return url.toString();
}
