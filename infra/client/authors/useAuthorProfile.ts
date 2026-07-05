import { useQuery } from "@tanstack/react-query";
import { fetchAuthorProfile } from "./authorsApi";

// Public author profile (published lessons only) for /learn/@username, for
// anyone viewing a username that isn't their own signed-in profile.
export function useAuthorProfile(username: string | undefined) {
  return useQuery({
    queryKey: ["authors", username],
    queryFn: () => fetchAuthorProfile(username!),
    enabled: !!username,
    staleTime: 60_000,
  });
}
