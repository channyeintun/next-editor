import { useQuery } from "@tanstack/react-query";
import axios from "axios";

const REPO_API = "https://api.github.com/repos/channyeintun/next-editor";

// Star count for the landing CTA badge. Cached for the session (queryClient
// default staleTime: Infinity) so re-mounting the landing page doesn't re-hit
// GitHub's rate-limited API. A failure is non-critical — `data` stays undefined
// and the badge simply hides, matching the previous fire-and-forget behavior.
export function useGitHubStars(): number | null {
  const { data } = useQuery({
    queryKey: ["github-stars"],
    queryFn: async ({ signal }) => {
      const res = await axios.get<{ stargazers_count: number }>(REPO_API, { signal });
      return res.data.stargazers_count;
    },
  });
  return typeof data === "number" ? data : null;
}
