import type {
  LessonRow,
  PlaylistRow,
  PlaylistRowWithCount,
  PlaylistRowWithMembership,
} from "./types";

// Shared subquery for PlaylistRowWithCount's first_lesson_thumbnail — the
// lowest-position currently-published member's thumbnail, used as the
// playlist's own cover image in the My Library card grid. Kept as one
// constant (not copy-pasted) since all three call sites below must produce
// the exact same PlaylistRowWithCount shape.
const FIRST_LESSON_THUMBNAIL_SUBQUERY = `(
  SELECT lessons.thumbnail FROM playlist_lessons
  JOIN lessons ON lessons.id = playlist_lessons.lesson_id
  WHERE playlist_lessons.playlist_id = playlists.id AND lessons.status = 'published'
  ORDER BY playlist_lessons.position ASC
  LIMIT 1
) AS first_lesson_thumbnail`;

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

// Owner-scoped membership read: every member row regardless of published
// status, in position order. Backs the manage panel — unlike the public
// getPlaylistBySlug above, an owner must be able to see (and remove) a member
// that was unpublished after being added, otherwise the membership row is
// stuck with no UI able to reach it. Returns null when the playlist doesn't
// exist or isn't owned by `ownerId`, so the route can 404 rather than leak
// membership of someone else's playlist.
export async function getOwnedPlaylistLessons(
  db: D1Database,
  playlistId: string,
  ownerId: string,
): Promise<LessonRow[] | null> {
  const playlist = await db
    .prepare("SELECT id FROM playlists WHERE id = ? AND owner_id = ?")
    .bind(playlistId, ownerId)
    .first();
  if (!playlist) return null;

  const result = await db
    .prepare(
      `SELECT lessons.* FROM playlist_lessons
       JOIN lessons ON lessons.id = playlist_lessons.lesson_id
       WHERE playlist_lessons.playlist_id = ?
       ORDER BY playlist_lessons.position ASC`,
    )
    .bind(playlistId)
    .all<LessonRow>();
  return result.results ?? [];
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
       ) AS lesson_count,
       ${FIRST_LESSON_THUMBNAIL_SUBQUERY}
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
       ) AS lesson_count,
       ${FIRST_LESSON_THUMBNAIL_SUBQUERY}
       FROM playlists
       WHERE owner_id = ?
       ORDER BY updated_at DESC`,
    )
    .bind(ownerId)
    .all<PlaylistRowWithCount>();
  return result.results ?? [];
}

// Backs the "Add to playlist" popover: every one of the owner's playlists,
// each flagged with whether `lessonId` is already a member — one request
// instead of the popover fetching each playlist's full membership to figure
// that out itself.
export async function listOwnedPlaylistsForLesson(
  db: D1Database,
  ownerId: string,
  lessonId: string,
): Promise<PlaylistRowWithMembership[]> {
  const result = await db
    .prepare(
      `SELECT playlists.*, (
         SELECT COUNT(*) FROM playlist_lessons WHERE playlist_lessons.playlist_id = playlists.id
       ) AS lesson_count,
       EXISTS(
         SELECT 1 FROM playlist_lessons
         WHERE playlist_lessons.playlist_id = playlists.id AND playlist_lessons.lesson_id = ?
       ) AS contains_lesson,
       ${FIRST_LESSON_THUMBNAIL_SUBQUERY}
       FROM playlists
       WHERE owner_id = ?
       ORDER BY updated_at DESC`,
    )
    .bind(lessonId, ownerId)
    .all<PlaylistRowWithMembership>();
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
    await db.batch([
      db
        .prepare(
          `INSERT INTO playlist_lessons (playlist_id, lesson_id, position, added_at)
           VALUES (?, ?, COALESCE((SELECT MAX(position) + 1 FROM playlist_lessons WHERE playlist_id = ?), 0), ?)`,
        )
        .bind(playlistId, lessonId, playlistId, now),
      db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").bind(now, playlistId),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed")) return "already_added";
    throw error;
  }

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

  // One atomic batch so a failure can't leave updated_at out of sync with the
  // membership row. The UPDATE runs first, gated on the membership existing —
  // after the DELETE that evidence is gone, and a no-op remove must not bump
  // updated_at (matching the pre-batch behavior).
  const results = await db.batch([
    db
      .prepare(
        `UPDATE playlists SET updated_at = ?
         WHERE id = ?
           AND EXISTS (SELECT 1 FROM playlist_lessons WHERE playlist_id = ? AND lesson_id = ?)`,
      )
      .bind(Date.now(), playlistId, playlistId, lessonId),
    db
      .prepare("DELETE FROM playlist_lessons WHERE playlist_id = ? AND lesson_id = ?")
      .bind(playlistId, lessonId),
  ]);
  return (results[1].meta.changes ?? 0) > 0;
}

// Rewrites every membership row's position atomically (db.batch(), same
// pattern updateUsername in queries.ts uses for its rename+author_url
// cascade). The client's list is a preference, not the source of truth: ids
// that aren't members (or repeat) are dropped, and members the client didn't
// mention — e.g. rows a stale client never saw — are appended in their
// current relative order. Positions therefore always come out dense over the
// full membership; trusting the submitted list verbatim could leave the
// untouched rows colliding with the rewritten 0..n-1 range.
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

  const membersResult = await db
    .prepare("SELECT lesson_id FROM playlist_lessons WHERE playlist_id = ? ORDER BY position ASC")
    .bind(playlistId)
    .all<{ lesson_id: string }>();
  const memberIds = (membersResult.results ?? []).map((row) => row.lesson_id);
  const memberIdSet = new Set(memberIds);

  const finalOrder: string[] = [];
  const placed = new Set<string>();
  for (const lessonId of orderedLessonIds) {
    if (memberIdSet.has(lessonId) && !placed.has(lessonId)) {
      placed.add(lessonId);
      finalOrder.push(lessonId);
    }
  }
  for (const lessonId of memberIds) {
    if (!placed.has(lessonId)) finalOrder.push(lessonId);
  }

  const now = Date.now();
  await db.batch([
    ...finalOrder.map((lessonId, index) =>
      db
        .prepare("UPDATE playlist_lessons SET position = ? WHERE playlist_id = ? AND lesson_id = ?")
        .bind(index, playlistId, lessonId),
    ),
    db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").bind(now, playlistId),
  ]);
  return true;
}
