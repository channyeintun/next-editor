import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addLessonToPlaylist,
  createPlaylist,
  deletePlaylist,
  fetchMyPlaylists,
  fetchMyPlaylistsForLesson,
  removeLessonFromPlaylist,
  reorderPlaylistLessons,
  updatePlaylist,
} from "./playlistsApi";

const MY_PLAYLISTS_QUERY_KEY = ["playlists", "mine"] as const;

export function useMyPlaylists() {
  return useQuery({
    queryKey: MY_PLAYLISTS_QUERY_KEY,
    queryFn: fetchMyPlaylists,
  });
}

// Backs the "Add to playlist" popover on a lesson card. Same "playlists"
// prefix as MY_PLAYLISTS_QUERY_KEY, so any mutation below invalidates it too.
export function usePlaylistsForLesson(lessonId: string | undefined) {
  return useQuery({
    queryKey: ["playlists", "mine", "for-lesson", lessonId],
    queryFn: () => fetchMyPlaylistsForLesson(lessonId!),
    enabled: !!lessonId,
  });
}

// Invalidates every query keyed under "playlists" (React Query matches by
// key prefix), not just MY_PLAYLISTS_QUERY_KEY — the My Library management
// panel also reads a specific playlist's current membership via tube's
// usePlaylist(slug) (key ["playlists", "detail", slug]), and the
// add-to-playlist popover reads usePlaylistsForLesson (key ["playlists",
// "mine", "for-lesson", lessonId]), all sharing the same QueryClient. A
// narrowly-scoped invalidation would need threading the slug/lessonId
// through every mutation; invalidating the whole "playlists" prefix is
// simpler and cheap at this scale. TData is preserved (not widened to
// unknown) so callers like useCreatePlaylist can chain off the created row.
function useMyPlaylistsMutation<TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["playlists"] }),
  });
}

export function useCreatePlaylist() {
  return useMyPlaylistsMutation((params: { title: string; description?: string }) =>
    createPlaylist(params),
  );
}

export function useUpdatePlaylist() {
  return useMyPlaylistsMutation(
    (params: { playlistId: string; title?: string; description?: string }) =>
      updatePlaylist(params.playlistId, { title: params.title, description: params.description }),
  );
}

export function useDeletePlaylist() {
  return useMyPlaylistsMutation((playlistId: string) => deletePlaylist(playlistId));
}

export function useAddLessonToPlaylist() {
  return useMyPlaylistsMutation((params: { playlistId: string; lessonId: string }) =>
    addLessonToPlaylist(params.playlistId, params.lessonId),
  );
}

export function useRemoveLessonFromPlaylist() {
  return useMyPlaylistsMutation((params: { playlistId: string; lessonId: string }) =>
    removeLessonFromPlaylist(params.playlistId, params.lessonId),
  );
}

export function useReorderPlaylistLessons() {
  return useMyPlaylistsMutation((params: { playlistId: string; lessonIds: string[] }) =>
    reorderPlaylistLessons(params.playlistId, params.lessonIds),
  );
}
