import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { playlistKeys } from "../../lessons/queryKeys";
import {
  addLessonToPlaylist,
  createPlaylist,
  deletePlaylist,
  fetchMyPlaylists,
  fetchMyPlaylistsForLesson,
  fetchPlaylistLessons,
  removeLessonFromPlaylist,
  reorderPlaylistLessons,
  updatePlaylist,
} from "./playlistsApi";

export function useMyPlaylists() {
  return useQuery({
    queryKey: playlistKeys.mine,
    queryFn: fetchMyPlaylists,
  });
}

// Backs the "Add to playlist" popover on a lesson card. Under the same
// playlistKeys.all prefix as playlistKeys.mine, so any mutation below
// invalidates it too.
export function usePlaylistsForLesson(lessonId: string | undefined) {
  return useQuery({
    queryKey: playlistKeys.forLesson(lessonId),
    queryFn: () => fetchMyPlaylistsForLesson(lessonId!),
    enabled: !!lessonId,
  });
}

// Owner-scoped membership (all members, including unpublished) for the
// manage panel. Same playlistKeys.all prefix, so every mutation below invalidates
// it, and so do the lessons mutations in useMyLessons.ts (a member's published
// status changes there). staleTime 0 (not the app default of Infinity) still
// refetches each time the panel opens, so it never shows a list from an
// earlier open.
export function usePlaylistLessons(playlistId: string | undefined) {
  return useQuery({
    queryKey: playlistKeys.members(playlistId),
    queryFn: () => fetchPlaylistLessons(playlistId!),
    enabled: !!playlistId,
    staleTime: 0,
  });
}

// Invalidates every query keyed under playlistKeys.all (React Query matches
// by key prefix), not just playlistKeys.mine — the My Library management
// panel also reads a specific playlist's current membership via tube's
// usePlaylist(slug) (playlistKeys.detail), and the add-to-playlist popover
// reads usePlaylistsForLesson (playlistKeys.forLesson), all sharing the same
// QueryClient; lessons/queryKeys.ts keeps every one of them under that
// prefix. A narrowly-scoped invalidation would need threading the
// slug/lessonId through every mutation; invalidating the whole prefix is
// simpler and cheap at this scale. TData is preserved (not widened to
// unknown) so callers like useCreatePlaylist can chain off the created row.
function useMyPlaylistsMutation<TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: playlistKeys.all }),
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
