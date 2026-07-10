import { apiClient } from "../apiClient";
import type { OwnedLesson, OwnedPlaylist, OwnedPlaylistWithMembership } from "../../db/types";

export async function fetchMyPlaylists(): Promise<OwnedPlaylist[]> {
  const res = await apiClient.get<{ playlists: OwnedPlaylist[] }>("/playlists/mine");
  return res.data.playlists;
}

// Backs the "Add to playlist" popover: every owned playlist, each flagged
// with whether `lessonId` is already a member.
export async function fetchMyPlaylistsForLesson(
  lessonId: string,
): Promise<OwnedPlaylistWithMembership[]> {
  const res = await apiClient.get<{ playlists: OwnedPlaylistWithMembership[] }>("/playlists/mine", {
    params: { lessonId },
  });
  return res.data.playlists;
}

// Owner-scoped membership for the manage panel: every member in playlist
// order, including currently-unpublished ones (the public by-slug read
// filters those out, which would make them unremovable).
export async function fetchPlaylistLessons(playlistId: string): Promise<OwnedLesson[]> {
  const res = await apiClient.get<{ lessons: OwnedLesson[] }>(`/playlists/${playlistId}/lessons`);
  return res.data.lessons;
}

export async function createPlaylist(params: {
  title: string;
  description?: string;
}): Promise<OwnedPlaylist> {
  const res = await apiClient.post<OwnedPlaylist>("/playlists", params);
  return res.data;
}

export async function updatePlaylist(
  playlistId: string,
  params: { title?: string; description?: string },
): Promise<OwnedPlaylist> {
  const res = await apiClient.patch<OwnedPlaylist>(`/playlists/${playlistId}`, params);
  return res.data;
}

export async function deletePlaylist(playlistId: string): Promise<void> {
  await apiClient.delete(`/playlists/${playlistId}`);
}

export async function addLessonToPlaylist(playlistId: string, lessonId: string): Promise<void> {
  await apiClient.post(`/playlists/${playlistId}/lessons`, { lessonId });
}

export async function removeLessonFromPlaylist(
  playlistId: string,
  lessonId: string,
): Promise<void> {
  await apiClient.delete(`/playlists/${playlistId}/lessons/${lessonId}`);
}

export async function reorderPlaylistLessons(
  playlistId: string,
  lessonIds: string[],
): Promise<void> {
  await apiClient.post(`/playlists/${playlistId}/reorder`, { lessonIds });
}
