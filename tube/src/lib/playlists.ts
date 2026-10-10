import type { Playlist } from "../types";
import { findCatalogItem } from "./catalogRequest";

// Playlists have no static seed shard (unlike lessons) — every playlist is
// user-created, so this always goes straight to the D1-backed API. Returns
// null (not undefined) on a real miss, same contract as findLessonBySlug.
export async function findPlaylistBySlug(slug: string): Promise<Playlist | null> {
  return findCatalogItem<Playlist>(`/api/playlists/${encodeURIComponent(slug)}`);
}
