import { apiClient } from "../apiClient";
import type { OwnedPlaylist } from "../../db/types";

export async function fetchMyPlaylists(): Promise<OwnedPlaylist[]> {
  const res = await apiClient.get<{ playlists: OwnedPlaylist[] }>("/playlists/mine");
  return res.data.playlists;
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
