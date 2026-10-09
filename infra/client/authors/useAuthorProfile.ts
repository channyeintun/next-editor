import { useQuery, useQueryClient } from "@tanstack/react-query";
import { primeLessonDetails } from "../../lessons/queryKeys";
import { fetchAuthorProfile } from "./authorsApi";

// Public author profile (published lessons only) for /learn/@username, for
// anyone viewing a username that isn't their own signed-in profile.
export function useAuthorProfile(username: string | undefined) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: ["authors", username],
    queryFn: async () => {
      const profile = await fetchAuthorProfile(username!);
      // Each lesson is the same whole row /api/lessons/:slug returns, so
      // opening one from the profile resolves from cache.
      primeLessonDetails(queryClient, profile?.lessons ?? []);
      return profile;
    },
    enabled: !!username,
    staleTime: 60_000,
  });
}
