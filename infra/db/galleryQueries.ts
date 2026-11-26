import {
  FIRST_LESSON_THUMBNAIL_SUBQUERY,
  PUBLISHED_LESSON_COUNT_SUBQUERY,
  PUBLISHED_MEMBERS,
} from "./playlistQueries";
import type { GalleryCardRow } from "./types";

// Which cards the public gallery shows, and in what order. A playlist stands
// in for every lesson it holds: it is one card, placed where its newest
// published lesson would have been, and those lessons get no card of their
// own. A published lesson in no playlist is its own card. Like every public
// view of a playlist (playlistQueries.ts), a playlist with no published
// member is not shown: its `shown_at` is null.
//
// Every published lesson stays reachable: a lesson left out here is a member
// of a playlist, and a playlist holding a published lesson is shown.
//
// The sort is a total order (see listPublishedLessons in queries.ts for why
// OFFSET paging needs one): `kind` breaks a tie between a playlist and a
// lesson published in the same millisecond, `id` a tie within a kind.
// `lesson_id NOT IN (…)` rather than NOT EXISTS: SQLite then reads the
// membership table once for the statement instead of once per lesson
// (playlist_lessons has no index that starts with lesson_id).
const CARD_KEYS = `
  SELECT 'playlist' AS kind, id, shown_at
  FROM (
    SELECT playlists.id AS id,
           (SELECT MAX(COALESCE(lessons.published_at, 0)) ${PUBLISHED_MEMBERS}) AS shown_at
    FROM playlists
  )
  WHERE shown_at IS NOT NULL
  UNION ALL
  SELECT 'lesson', lessons.id, COALESCE(lessons.published_at, 0)
  FROM lessons
  WHERE lessons.status = 'published'
    AND lessons.id NOT IN (SELECT lesson_id FROM playlist_lessons)
  ORDER BY shown_at DESC, kind DESC, id DESC
  LIMIT ?1 OFFSET ?2`;

export interface ListGalleryCardsResult {
  rows: GalleryCardRow[];
  nextPage: number | null;
}

/**
 * One page of the public gallery's cards, newest first: GET /api/gallery's
 * rows. One statement, so one D1 round trip: the page's keys are picked first,
 * then each is joined to its lesson or its playlist.
 */
export async function listGalleryCards(
  db: D1Database,
  page: number,
  pageSize: number,
): Promise<ListGalleryCardsResult> {
  const offset = page * pageSize;
  // As in listPublishedLessons: an offset past the int64 range binds as a REAL
  // and SQLite rejects it, where every other out-of-range page is empty.
  if (!Number.isSafeInteger(offset)) {
    return { rows: [], nextPage: null };
  }

  const result = await db
    .prepare(
      `WITH cards AS (${CARD_KEYS})
       SELECT cards.kind AS kind,
              card_lesson.*,
              playlists.slug AS playlist_slug,
              playlists.title AS playlist_title,
              playlists.description AS playlist_description,
              ${PUBLISHED_LESSON_COUNT_SUBQUERY},
              ${FIRST_LESSON_THUMBNAIL_SUBQUERY},
              users.name AS playlist_author,
              users.username AS playlist_author_username
       FROM cards
       LEFT JOIN lessons AS card_lesson ON cards.kind = 'lesson' AND card_lesson.id = cards.id
       LEFT JOIN playlists ON cards.kind = 'playlist' AND playlists.id = cards.id
       LEFT JOIN users ON users.id = playlists.owner_id
       ORDER BY cards.shown_at DESC, cards.kind DESC, cards.id DESC`,
    )
    .bind(pageSize + 1, offset)
    .all<GalleryCardRow>();

  const rows = result.results ?? [];
  const hasNextPage = rows.length > pageSize;

  return {
    rows: hasNextPage ? rows.slice(0, pageSize) : rows,
    nextPage: hasNextPage ? page + 1 : null,
  };
}
