import type { LessonRow, PlaylistRow, PlaylistRowWithCount } from "./types";

export interface InsertPlaylistParams {
  id: string;
  slug: string;
  ownerId: string;
  title: string;
  description: string | null;
}

export async function insertPlaylist(
  db: D1Database,
  params: InsertPlaylistParams,
): Promise<PlaylistRow> {
  const now = Date.now();
  const row = await db
    .prepare(
      `INSERT INTO playlists (id, slug, owner_id, title, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .bind(params.id, params.slug, params.ownerId, params.title, params.description, now, now)
    .first<PlaylistRow>();
  if (!row) {
    throw new Error("insertPlaylist: INSERT ... RETURNING produced no row");
  }
  return row;
}

export async function getPlaylistById(db: D1Database, id: string): Promise<PlaylistRow | null> {
  const row = await db
    .prepare("SELECT * FROM playlists WHERE id = ?")
    .bind(id)
    .first<PlaylistRow>();
  return row ?? null;
}

export interface PlaylistWithLessons {
  playlist: PlaylistRow;
  lessons: LessonRow[];
}

// Public read: only lessons currently status='published' are included, even
// though playlists themselves have no draft state (they're always public) —
// a lesson can be unpublished after being added to a playlist, and this
// filter (re-applied on every read, not just at insert time) is what keeps it
// from leaking through the playlist page. Mirrors getPublishedLessonBySlug's
// same published-only convention in queries.ts.
export async function getPlaylistBySlug(
  db: D1Database,
  slug: string,
): Promise<PlaylistWithLessons | null> {
  const playlist = await db
    .prepare("SELECT * FROM playlists WHERE slug = ?")
    .bind(slug)
    .first<PlaylistRow>();
  if (!playlist) return null;

  const result = await db
    .prepare(
      `SELECT lessons.* FROM playlist_lessons
       JOIN lessons ON lessons.id = playlist_lessons.lesson_id
       WHERE playlist_lessons.playlist_id = ? AND lessons.status = 'published'
       ORDER BY playlist_lessons.position ASC`,
    )
    .bind(playlist.id)
    .all<LessonRow>();

  return { playlist, lessons: result.results ?? [] };
}

export async function getOwnedPlaylistById(
  db: D1Database,
  id: string,
  ownerId: string,
): Promise<PlaylistRowWithCount | null> {
  const row = await db
    .prepare(
      `SELECT playlists.*, (
         SELECT COUNT(*) FROM playlist_lessons WHERE playlist_lessons.playlist_id = playlists.id
       ) AS lesson_count
       FROM playlists
       WHERE id = ? AND owner_id = ?`,
    )
    .bind(id, ownerId)
    .first<PlaylistRowWithCount>();
  return row ?? null;
}

// All of an owner's playlists, newest-updated first — backs "My Library"
// management. Unlike getPlaylistBySlug, no published filter on membership
// count: the owner should see every lesson they've added, including one that
// was unpublished afterward, so they can notice and fix it.
export async function listOwnedPlaylists(
  db: D1Database,
  ownerId: string,
): Promise<PlaylistRowWithCount[]> {
  const result = await db
    .prepare(
      `SELECT playlists.*, (
         SELECT COUNT(*) FROM playlist_lessons WHERE playlist_lessons.playlist_id = playlists.id
       ) AS lesson_count
       FROM playlists
       WHERE owner_id = ?
       ORDER BY updated_at DESC`,
    )
    .bind(ownerId)
    .all<PlaylistRowWithCount>();
  return result.results ?? [];
}

export interface UpdatePlaylistParams {
  title?: string;
  description?: string;
}

// Only touches columns actually present in `params`, same dynamic SET-clause
// pattern as updateLesson in queries.ts — owner_id is part of the WHERE, so a
// non-owner's update silently matches zero rows rather than needing a
// separate read.
export async function updatePlaylist(
  db: D1Database,
  id: string,
  ownerId: string,
  params: UpdatePlaylistParams,
): Promise<PlaylistRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (params.title !== undefined) {
    sets.push("title = ?");
    values.push(params.title);
  }
  if (params.description !== undefined) {
    sets.push("description = ?");
    values.push(params.description);
  }
  if (sets.length === 0) {
    return getPlaylistById(db, id);
  }
  sets.push("updated_at = ?");
  values.push(Date.now(), id, ownerId);

  const row = await db
    .prepare(`UPDATE playlists SET ${sets.join(", ")} WHERE id = ? AND owner_id = ? RETURNING *`)
    .bind(...values)
    .first<PlaylistRow>();
  return row ?? null;
}

export async function deletePlaylist(
  db: D1Database,
  id: string,
  ownerId: string,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM playlists WHERE id = ? AND owner_id = ?")
    .bind(id, ownerId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export type AddLessonResult = "ok" | "not_found" | "lesson_not_eligible" | "already_added";

// Validates ownership of both the playlist and the lesson (and that the
// lesson is published) before inserting the membership row — only the
// owner's own published lessons are ever addable, per the "own lessons only"
// product decision. Position is appended at the end (MAX(position)+1).
export async function addLessonToPlaylist(
  db: D1Database,
  playlistId: string,
  ownerId: string,
  lessonId: string,
): Promise<AddLessonResult> {
  const playlist = await db
    .prepare("SELECT id FROM playlists WHERE id = ? AND owner_id = ?")
    .bind(playlistId, ownerId)
    .first();
  if (!playlist) return "not_found";

  const lesson = await db
    .prepare("SELECT id FROM lessons WHERE id = ? AND owner_id = ? AND status = 'published'")
    .bind(lessonId, ownerId)
    .first();
  if (!lesson) return "lesson_not_eligible";

  const now = Date.now();
  try {
    await db
      .prepare(
        `INSERT INTO playlist_lessons (playlist_id, lesson_id, position, added_at)
         VALUES (?, ?, COALESCE((SELECT MAX(position) + 1 FROM playlist_lessons WHERE playlist_id = ?), 0), ?)`,
      )
      .bind(playlistId, lessonId, playlistId, now)
      .run();
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed")) return "already_added";
    throw error;
  }

  await db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").bind(now, playlistId).run();
  return "ok";
}

export async function removeLessonFromPlaylist(
  db: D1Database,
  playlistId: string,
  ownerId: string,
  lessonId: string,
): Promise<boolean> {
  const playlist = await db
    .prepare("SELECT id FROM playlists WHERE id = ? AND owner_id = ?")
    .bind(playlistId, ownerId)
    .first();
  if (!playlist) return false;

  const result = await db
    .prepare("DELETE FROM playlist_lessons WHERE playlist_id = ? AND lesson_id = ?")
    .bind(playlistId, lessonId)
    .run();
  if ((result.meta.changes ?? 0) > 0) {
    await db
      .prepare("UPDATE playlists SET updated_at = ? WHERE id = ?")
      .bind(Date.now(), playlistId)
      .run();
  }
  return (result.meta.changes ?? 0) > 0;
}

// Rewrites every membership row's position to match orderedLessonIds' index,
// atomically (db.batch(), same pattern updateUsername in queries.ts uses for
// its rename+author_url cascade) — a partial reorder would otherwise leave
// positions inconsistent.
export async function reorderPlaylistLessons(
  db: D1Database,
  playlistId: string,
  ownerId: string,
  orderedLessonIds: string[],
): Promise<boolean> {
  const playlist = await db
    .prepare("SELECT id FROM playlists WHERE id = ? AND owner_id = ?")
    .bind(playlistId, ownerId)
    .first();
  if (!playlist) return false;

  const now = Date.now();
  await db.batch([
    ...orderedLessonIds.map((lessonId, index) =>
      db
        .prepare("UPDATE playlist_lessons SET position = ? WHERE playlist_id = ? AND lesson_id = ?")
        .bind(index, playlistId, lessonId),
    ),
    db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").bind(now, playlistId),
  ]);
  return true;
}
