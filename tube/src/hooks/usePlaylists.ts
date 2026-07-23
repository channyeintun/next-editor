import { useQuery, useQueryClient } from "@tanstack/react-query";
import { findPlaylistBySlug } from "../lib/playlists";
import { primeLessonDetails } from "./useLessons";

// Single playlist by slug for the public detail route and the lesson page's
// playlist mode. (The My Library manage panel uses infra's owner-scoped
// usePlaylistLessons instead — this public read filters out unpublished
// members, which the owner must still see to remove.) `data` is the playlist,
// or null when the slug doesn't match any playlist (vs. isError for a fetch
// failure) — same contract as useLesson in useLessons.ts.
// Same live-data override of the app's default staleTime: Infinity, since
// playlist membership changes as the owner edits it.
export function usePlaylist(slug: string | undefined) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: ["playlists", "detail", slug],
    queryFn: async () => {
      const playlist = await findPlaylistBySlug(slug!);
      // A playlist carries its members in full, so opening one from here — or
      // auto-advancing to the next lesson in playlist mode — needs no further
      // lookup.
      if (playlist) {
        primeLessonDetails(queryClient, playlist.lessons);
      }
      return playlist;
    },
    enabled: !!slug,
    staleTime: 60_000,
  });
}
