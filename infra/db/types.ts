import type { Lesson, Playlist } from "../../tube/src/types";

export interface UserRow {
  id: string;
  google_sub: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  username: string;
  created_at: number;
}

/** Shape returned to the client (GET /api/auth/me) — no google_sub. */
export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  username: string;
}

export function userRowToAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    username: row.username,
  };
}

/** Public author info — used by the author-profile and search endpoints. */
export interface AuthorSummary {
  username: string;
  name: string | null;
  avatarUrl: string | null;
}

export function userRowToAuthorSummary(row: UserRow): AuthorSummary {
  return {
    username: row.username,
    name: row.name,
    avatarUrl: row.avatar_url,
  };
}

export interface SessionRow {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}

export interface PasskeyCredentialRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  created_at: number;
  last_used_at: number | null;
}

export type LessonStatus = "draft" | "published";

export interface LessonRow {
  id: string;
  slug: string;
  owner_id: string;
  title: string;
  description: string | null;
  thumbnail: string | null;
  ne: string;
  duration: string | null;
  tags: string | null;
  author: string | null;
  author_url: string | null;
  status: LessonStatus;
  published_at: number | null;
  created_at: number;
  updated_at: number;
}

export function lessonRowToLesson(row: LessonRow): Lesson {
  return {
    slug: row.slug,
    title: row.title,
    description: row.description ?? "",
    thumbnail: row.thumbnail ?? "",
    ne: row.ne,
    duration: row.duration ?? undefined,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : undefined,
    author: row.author ?? undefined,
    authorUrl: row.author_url ?? undefined,
    publishedAt: row.published_at
      ? new Date(row.published_at).toISOString().slice(0, 10)
      : undefined,
  };
}

/**
 * Shape returned to the owner from the write routes (create/update/publish) —
 * unlike the public `Lesson`, this includes `id` (needed for further
 * PATCH/publish/DELETE calls) and `status` (draft vs. published), and keeps
 * `publishedAt` as a raw epoch-ms timestamp rather than the display-formatted
 * date string the public gallery uses.
 */
export interface OwnedLesson {
  id: string;
  slug: string;
  title: string;
  description: string;
  thumbnail: string;
  ne: string;
  duration: string | null;
  tags: string[];
  status: LessonStatus;
  publishedAt: number | null;
}

export function lessonRowToOwnedLesson(row: LessonRow): OwnedLesson {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description ?? "",
    thumbnail: row.thumbnail ?? "",
    ne: row.ne,
    duration: row.duration,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
    status: row.status,
    publishedAt: row.published_at,
  };
}

export interface PlaylistRow {
  id: string;
  slug: string;
  owner_id: string;
  title: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * listOwnedPlaylists's row shape — PlaylistRow plus a COUNT(*) subquery alias
 * and the current first (lowest-position) published member's thumbnail, used
 * as the playlist's own cover image in the My Library card grid. Null for an
 * empty playlist, or one whose only members are all currently unpublished.
 */
export interface PlaylistRowWithCount extends PlaylistRow {
  lesson_count: number;
  first_lesson_thumbnail: string | null;
}

export function playlistRowToPlaylist(row: PlaylistRow, lessons: LessonRow[]): Playlist {
  return {
    slug: row.slug,
    title: row.title,
    description: row.description ?? "",
    lessons: lessons.map(lessonRowToLesson),
  };
}

/**
 * Shape returned to the owner for "My Library" management — unlike the
 * public `Playlist`, this includes `id` (needed for further PATCH/add/
 * remove/reorder/DELETE calls) and a `lessonCount` instead of the full
 * lesson list (the management UI fetches membership separately when a
 * playlist is expanded).
 */
export interface OwnedPlaylist {
  id: string;
  slug: string;
  title: string;
  description: string;
  lessonCount: number;
  updatedAt: number;
  /** Cover image — the first published member's thumbnail, or null (empty playlist). */
  thumbnail: string | null;
}

export function playlistRowToOwnedPlaylist(row: PlaylistRowWithCount): OwnedPlaylist {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description ?? "",
    lessonCount: row.lesson_count,
    updatedAt: row.updated_at,
    thumbnail: row.first_lesson_thumbnail,
  };
}

/**
 * Public playlist card shape for the author profile — like OwnedPlaylist but
 * without the owner-only `id`/`updatedAt` (the public profile only links by
 * slug and has no manage actions). `lessonCount` here is the published-member
 * count (see listPublishedPlaylistsByOwner), matching what the public playlist
 * page actually shows.
 */
export interface PlaylistSummary {
  slug: string;
  title: string;
  description: string;
  lessonCount: number;
  /** Cover image — the first published member's thumbnail, or null. */
  thumbnail: string | null;
}

export function playlistRowToPlaylistSummary(row: PlaylistRowWithCount): PlaylistSummary {
  return {
    slug: row.slug,
    title: row.title,
    description: row.description ?? "",
    lessonCount: row.lesson_count,
    thumbnail: row.first_lesson_thumbnail,
  };
}

/** listOwnedPlaylistsForLesson's row shape — adds an EXISTS(...) membership flag. */
export interface PlaylistRowWithMembership extends PlaylistRowWithCount {
  contains_lesson: number;
}

/**
 * Backs the "Add to playlist" popover on a lesson card: every one of the
 * owner's playlists, each flagged with whether the given lesson is already a
 * member — lets the popover render pre-checked toggles in one request
 * instead of one request per playlist.
 */
export interface OwnedPlaylistWithMembership extends OwnedPlaylist {
  containsLesson: boolean;
}

export function playlistRowToOwnedPlaylistWithMembership(
  row: PlaylistRowWithMembership,
): OwnedPlaylistWithMembership {
  return {
    ...playlistRowToOwnedPlaylist(row),
    containsLesson: row.contains_lesson === 1,
  };
}
