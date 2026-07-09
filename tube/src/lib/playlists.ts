import axios from "axios";
import type { Playlist } from "../types";

function is404(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 404;
}

// Same dev-without-worker / SPA-fallback guard as findLessonBySlug in
// lessons.ts: an unmatched path under the Worker's SPA fallback is a 200
// carrying index.html, not a real 404.
function isHtmlFallback(res: { headers: Record<string, unknown> }): boolean {
  const contentType = res.headers["content-type"];
  return typeof contentType === "string" && contentType.includes("text/html");
}

// Playlists have no static seed shard (unlike lessons) — every playlist is
// user-created, so this always goes straight to the D1-backed API. Returns
// null (not undefined) on a real miss, same contract as findLessonBySlug.
export async function findPlaylistBySlug(slug: string): Promise<Playlist | null> {
  try {
    const res = await axios.get<Playlist>(`/api/playlists/${encodeURIComponent(slug)}`);
    if (isHtmlFallback(res)) return null;
    return res.data;
  } catch (err) {
    if (is404(err)) return null;
    throw err;
  }
}
