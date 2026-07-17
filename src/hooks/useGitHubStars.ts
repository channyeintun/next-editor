import { useQuery } from "@tanstack/react-query";

const REPO_API = "https://api.github.com/repos/channyeintun/next-editor";

// Star count for the landing CTA badge. Cached for the session (queryClient
// default staleTime: Infinity) so re-mounting the landing page doesn't re-hit
// GitHub's rate-limited API. A failure is non-critical — `data` stays undefined
// and the badge simply hides, matching the previous fire-and-forget behavior.
export function useGitHubStars(): number | null {
  const { data } = useQuery({
    queryKey: ["github-stars"],
    queryFn: async ({ signal }) => {
      const response = await fetch(REPO_API, {
        signal,
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!response.ok) {
        throw new Error(`GitHub star request failed with status ${response.status}`);
      }
      const body = (await response.json()) as { stargazers_count?: unknown };
      if (typeof body.stargazers_count !== "number") {
        throw new Error("GitHub star response did not include a numeric count");
      }
      return body.stargazers_count;
    },
  });
  return typeof data === "number" ? data : null;
}
