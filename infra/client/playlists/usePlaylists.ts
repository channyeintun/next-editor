import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addLessonToPlaylist,
  createPlaylist,
  deletePlaylist,
  fetchMyPlaylists,
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

// Invalidates every query keyed under "playlists" (React Query matches by
// key prefix), not just MY_PLAYLISTS_QUERY_KEY — the My Library management
// panel also reads a specific playlist's current membership via tube's
// usePlaylist(slug) (key ["playlists", "detail", slug]), sharing the same
// QueryClient. A slug-scoped invalidation would need threading the slug
// through every mutation; invalidating the whole "playlists" prefix is
// simpler and cheap at this scale.
function useMyPlaylistsMutation<TVariables>(
  mutationFn: (variables: TVariables) => Promise<unknown>,
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
