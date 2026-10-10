import type { LessonRow, SessionRow, UserRow } from "./types";
import { isUniqueViolation } from "./uniqueViolation";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Escapes LIKE metacharacters in user-supplied search text so `%`, `_`, and
// `\` are matched literally instead of acting as wildcards.
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface UpsertUserParams {
  googleSub: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

/**
 * The shape of every username issued or chosen today: 3-32 characters of
 * lowercase letters, digits and hyphens, with no hyphen at either end.
 * generateUniqueUsername below only produces it, and PATCH /api/auth/username
 * only accepts it.
 *
 * Accounts from before 2026-09-23 may hold a name outside it: shorter or longer
 * (the generator had no length bound, and renames once allowed one character),
 * or, from 0002's backfill, other characters of the Google display name. They
 * are kept on purpose. Lookups are exact matches, so those profiles and author
 * links work, and renaming them would break links people have shared; their
 * owners can rename into this shape from their profile. Backfilled names
 * holding '/', '\', '?', '#' or an ASCII percent-escape, which broke their
 * /learn/@ URL, were rewritten by migration 0014_reachable_usernames.sql.
 */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

// Leaves room for the longest suffix generateUniqueUsername appends (a hyphen
// and 8 random hex characters) within USERNAME_PATTERN's 32.
const MAX_USERNAME_BASE_CHARS = 23;

function slugifyUsername(base: string): string {
  const slug = base
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_USERNAME_BASE_CHARS)
    .replace(/^-+|-+$/g, "");
  return slug || "user";
}

// Bounds the probe loop, as MAX_SLUG_SUFFIX_PROBES does in slug.ts: every name
// with no ASCII alphanumerics (a display name written entirely in Burmese,
// Chinese, Cyrillic, Arabic…) slugifies to the same "user" base, so without a
// ceiling each new member of that cohort walks the whole series one sequential
// D1 round-trip at a time inside a single OAuth-callback invocation.
const MAX_USERNAME_SUFFIX_PROBES = 50;

// Generates a username unique against the DB by appending -1, -2, ... on
// collision. Only called once per user, at creation — see updateUsername
// below for renames (which also has to keep the lesson author_url cascade
// in sync, unlike this initial assignment).
async function generateUniqueUsername(db: D1Database, base: string): Promise<string> {
  const slug = slugifyUsername(base);
  for (let suffix = 0; suffix <= MAX_USERNAME_SUFFIX_PROBES; suffix++) {
    const candidate = suffix === 0 ? slug : `${slug}-${suffix}`;
    // A one- or two-letter name ("Jo") is too short on its own; it starts at "-1".
    if (!USERNAME_PATTERN.test(candidate)) continue;
    const existing = await db
      .prepare("SELECT 1 FROM users WHERE username = ?")
      .bind(candidate)
      .first();
    if (!existing) return candidate;
  }
  // Past the ceiling, stop probing and take a random suffix. The caller's
  // INSERT retry still covers the (vanishingly unlikely) collision.
  return `${slug}-${crypto.randomUUID().slice(0, 8)}`;
}

// Bounds the retry loop below: a persistent, unrelated failure should surface
// as an error rather than spin forever.
const MAX_USERNAME_INSERT_ATTEMPTS = 5;

// Keyed on google_sub (stable across logins); email/name/avatar refresh on
// every sign-in so profile changes on the Google side propagate here.
// username is only assigned here on first sign-in, never touched again by
// this function afterward — see updateUsername for user-initiated renames.
// The refresh runs first, as one UPDATE ... RETURNING, so a returning user
// costs one round trip; only when it matches no row does the INSERT path run
// (unlike a single INSERT ... ON CONFLICT, that path needs a new user's
// username looked up for uniqueness before the row exists).
export async function upsertUserByGoogleSub(
  db: D1Database,
  params: UpsertUserParams,
): Promise<UserRow> {
  const existing = await db
    .prepare(
      `UPDATE users SET email = ?, name = ?, avatar_url = ?
       WHERE google_sub = ?
       RETURNING *`,
    )
    .bind(params.email, params.name, params.avatarUrl, params.googleSub)
    .first<UserRow>();
  if (existing) return existing;

  const base = params.name ?? params.email.split("@")[0];
  for (let attempt = 1; ; attempt++) {
    const username = await generateUniqueUsername(db, base);
    try {
      const row = await db
        .prepare(
          `INSERT INTO users (id, google_sub, email, name, avatar_url, username, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           RETURNING *`,
        )
        .bind(
          crypto.randomUUID(),
          params.googleSub,
          params.email,
          params.name,
          params.avatarUrl,
          username,
          Date.now(),
        )
        .first<UserRow>();
      if (!row) {
        throw new Error("upsertUserByGoogleSub: INSERT ... RETURNING produced no row");
      }
      return row;
    } catch (error) {
      // Two concurrent first-sign-ins for the same brand-new google_sub (e.g.
      // the OAuth callback opened in two tabs) both find no row to UPDATE above
      // and race to INSERT; the loser hits the UNIQUE(google_sub) constraint. The
      // winner's row is what should be returned either way.
      const row = await db
        .prepare("SELECT * FROM users WHERE google_sub = ?")
        .bind(params.googleSub)
        .first<UserRow>();
      if (row) return row;

      // Not a google_sub race: two concurrent brand-new sign-ins independently
      // generated the same username between generateUniqueUsername's read and
      // this INSERT. D1 serializes writes, so a retry's SELECT will see the
      // winner's row and pick the next suffix instead of colliding again.
      if (!isUniqueViolation(error, "users.username") || attempt >= MAX_USERNAME_INSERT_ATTEMPTS) {
        throw error;
      }
    }
  }
}

export async function createSession(db: D1Database, userId: string): Promise<SessionRow> {
  const now = Date.now();
  const session: SessionRow = {
    id: crypto.randomUUID(),
    user_id: userId,
    created_at: now,
    expires_at: now + SESSION_TTL_MS,
  };
  // Opportunistic cleanup: sweep this user's own expired sessions on every new
  // sign-in so the table doesn't grow unbounded (there's no separate cron for
  // this yet). Bounded to this user's rows only, so it stays cheap, and batched
  // with the INSERT so sign-in pays one round trip for both.
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?").bind(userId, now),
    db
      .prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(session.id, session.user_id, session.created_at, session.expires_at),
  ]);
  return session;
}

// Null for a missing OR expired session — callers don't need to distinguish
// the two (both mean "not signed in").
export async function getSessionUser(db: D1Database, sessionId: string): Promise<UserRow | null> {
  const row = await db
    .prepare(
      `SELECT users.* FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.id = ? AND sessions.expires_at > ?`,
    )
    .bind(sessionId, Date.now())
    .first<UserRow>();
  return row ?? null;
}

export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
}

export interface ListPublishedLessonsResult {
  rows: LessonRow[];
  nextPage: number | null;
}

export async function listPublishedLessons(
  db: D1Database,
  page: number,
  pageSize = 12,
): Promise<ListPublishedLessonsResult> {
  const offset = page * pageSize;
  // An offset past the int64 range binds as a REAL and SQLite answers
  // "datatype mismatch", so a hand-crafted `?page=1e300` became a 500 rather
  // than the empty page every other out-of-range page returns.
  if (!Number.isSafeInteger(offset)) {
    return { rows: [], nextPage: null };
  }

  const result = await db
    .prepare(
      // `id` is not decoration: OFFSET paging only works when the sort is a
      // TOTAL order. `published_at` alone is not one — a backfill or a bulk
      // publish gives several rows the same millisecond, and SQLite is then
      // free to return tied rows in storage order, which can differ between
      // the query for page N and the query for page N+1 (they are separate
      // requests). A tie straddling a page boundary then lands on both pages:
      // the gallery shows one lesson twice and silently never shows another.
      `SELECT * FROM lessons WHERE status = 'published'
       ORDER BY published_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(pageSize + 1, offset)
    .all<LessonRow>();

  const rows = result.results ?? [];
  const hasNextPage = rows.length > pageSize;

  return {
    rows: hasNextPage ? rows.slice(0, pageSize) : rows,
    nextPage: hasNextPage ? page + 1 : null,
  };
}

export async function getPublishedLessonBySlug(
  db: D1Database,
  slug: string,
): Promise<LessonRow | null> {
  const result = await db
    .prepare("SELECT * FROM lessons WHERE slug = ? AND status = 'published' LIMIT 1")
    .bind(slug)
    .first<LessonRow>();

  return result ?? null;
}

export async function getLessonById(db: D1Database, id: string): Promise<LessonRow | null> {
  const row = await db.prepare("SELECT * FROM lessons WHERE id = ?").bind(id).first<LessonRow>();
  return row ?? null;
}

// Owner-scoped counterpart to getLessonById. Callers acting on behalf of a
// signed-in user must use this one, so a miss is indistinguishable from a
// lesson that does not exist.
export async function getOwnedLessonById(
  db: D1Database,
  id: string,
  ownerId: string,
): Promise<LessonRow | null> {
  const row = await db
    .prepare("SELECT * FROM lessons WHERE id = ? AND owner_id = ?")
    .bind(id, ownerId)
    .first<LessonRow>();
  return row ?? null;
}

export interface InsertDraftLessonParams {
  id: string;
  slug: string;
  ownerId: string;
  title: string;
  description: string | null;
  thumbnail: string | null;
  ne: string;
  duration: string | null;
  tags: string[] | null;
  author: string | null;
  authorUrl: string | null;
}

export async function insertDraftLesson(
  db: D1Database,
  params: InsertDraftLessonParams,
): Promise<LessonRow> {
  const now = Date.now();
  const row = await db
    .prepare(
      `INSERT INTO lessons
         (id, slug, owner_id, title, description, thumbnail, ne, duration, tags,
          author, author_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
       RETURNING *`,
    )
    .bind(
      params.id,
      params.slug,
      params.ownerId,
      params.title,
      params.description,
      params.thumbnail,
      params.ne,
      params.duration,
      params.tags ? JSON.stringify(params.tags) : null,
      params.author,
      params.authorUrl,
      now,
      now,
    )
    .first<LessonRow>();
  if (!row) {
    throw new Error("insertDraftLesson: INSERT ... RETURNING produced no row");
  }
  return row;
}

export interface UpdateLessonParams {
  title?: string;
  description?: string;
  tags?: string[] | null;
  thumbnail?: string;
}

// Only touches columns actually present in `params` — column names in the SET
// clause are always fixed literals from this function's own whitelist, never
// derived from caller input; only values are parameter-bound. owner_id is
// part of the WHERE, not just a post-hoc check, so a non-owner's update
// silently matches zero rows (null) rather than needing a separate read.
export async function updateLesson(
  db: D1Database,
  id: string,
  ownerId: string,
  params: UpdateLessonParams,
): Promise<LessonRow | null> {
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
  if (params.tags !== undefined) {
    sets.push("tags = ?");
    values.push(params.tags ? JSON.stringify(params.tags) : null);
  }
  if (params.thumbnail !== undefined) {
    sets.push("thumbnail = ?");
    values.push(params.thumbnail);
  }
  if (sets.length === 0) {
    // A no-op update still has to answer as the owner-scoped UPDATE below
    // would. Using the unscoped getLessonById here made `PATCH /api/lessons/:id`
    // with an empty body a read oracle for any lesson id, including drafts the
    // author had unpublished, defeating the route's 404-for-non-owners contract.
    return getOwnedLessonById(db, id, ownerId);
  }
  sets.push("updated_at = ?");
  values.push(Date.now(), id, ownerId);

  const row = await db
    .prepare(`UPDATE lessons SET ${sets.join(", ")} WHERE id = ? AND owner_id = ? RETURNING *`)
    .bind(...values)
    .first<LessonRow>();
  return row ?? null;
}

export async function publishLesson(
  db: D1Database,
  id: string,
  ownerId: string,
): Promise<LessonRow | null> {
  const now = Date.now();
  const row = await db
    .prepare(
      `UPDATE lessons SET status = 'published', published_at = ?, updated_at = ?
       WHERE id = ? AND owner_id = ?
       RETURNING *`,
    )
    .bind(now, now, id, ownerId)
    .first<LessonRow>();
  return row ?? null;
}

export async function unpublishLesson(
  db: D1Database,
  id: string,
  ownerId: string,
): Promise<LessonRow | null> {
  const row = await db
    .prepare(
      `UPDATE lessons SET status = 'draft', published_at = NULL, updated_at = ?
       WHERE id = ? AND owner_id = ?
       RETURNING *`,
    )
    .bind(Date.now(), id, ownerId)
    .first<LessonRow>();
  return row ?? null;
}

// All of an owner's lessons regardless of status, newest-updated first — backs
// the "My Library" view (unlike listPublishedLessons, drafts are included and
// there's no pagination since a single author's lesson count is small).
export async function listOwnedLessons(db: D1Database, ownerId: string): Promise<LessonRow[]> {
  const result = await db
    .prepare("SELECT * FROM lessons WHERE owner_id = ? ORDER BY updated_at DESC")
    .bind(ownerId)
    .all<LessonRow>();
  return result.results ?? [];
}

export async function deleteLesson(db: D1Database, id: string, ownerId: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM lessons WHERE id = ? AND owner_id = ?")
    .bind(id, ownerId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export type UpdateUsernameResult = { status: "ok"; user: UserRow } | { status: "taken" };

// Renames a user and cascades the change into every lesson's denormalized
// author_url (see insertDraftLesson) in one D1 batch, so the rename and the
// link update commit atomically — a partial failure would otherwise leave
// published lessons pointing at a username that no longer exists.
export async function updateUsername(
  db: D1Database,
  userId: string,
  newUsername: string,
): Promise<UpdateUsernameResult> {
  try {
    const [userResult] = await db.batch<UserRow>([
      db
        .prepare("UPDATE users SET username = ? WHERE id = ? RETURNING *")
        .bind(newUsername, userId),
      db
        .prepare("UPDATE lessons SET author_url = ? WHERE owner_id = ?")
        .bind(`/learn/@${newUsername}`, userId),
    ]);
    const row = userResult.results?.[0];
    if (!row) {
      throw new Error("updateUsername: UPDATE ... RETURNING produced no row");
    }
    return { status: "ok", user: row };
  } catch (error) {
    if (isUniqueViolation(error, "users.username")) {
      return { status: "taken" };
    }
    throw error;
  }
}

/**
 * Whose rows a public author read selects: a user id, or a username, which the
 * statement resolves itself (users.username is UNIQUE, so it is one index
 * lookup) so a batch can run it alongside the user read instead of after it.
 */
export type AuthorRef = { id: string } | { username: string };

/** The `owner_id` condition, and its one bound value, that selects `owner`'s rows. */
export function ownerCondition(owner: AuthorRef): { sql: string; value: string } {
  return "id" in owner
    ? { sql: "owner_id = ?", value: owner.id }
    : { sql: "owner_id = (SELECT id FROM users WHERE username = ?)", value: owner.username };
}

// Backs the public author-profile view (/learn/@username for anyone but the
// owner) — published only, unlike listOwnedLessons. A statement rather than a
// read so getPublishedAuthorProfile can batch it.
export function publishedLessonsByOwnerStatement(
  db: D1Database,
  owner: AuthorRef,
): D1PreparedStatement {
  const { sql, value } = ownerCondition(owner);
  return db
    .prepare(
      `SELECT * FROM lessons WHERE ${sql} AND status = 'published' ORDER BY published_at DESC, id DESC`,
    )
    .bind(value);
}

// Backs GET /api/search — authors matched by username or display name.
export async function searchUsers(db: D1Database, q: string, limit: number): Promise<UserRow[]> {
  const like = `%${escapeLikePattern(q)}%`;
  const result = await db
    .prepare(
      `SELECT * FROM users
       WHERE username LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'
       ORDER BY name LIMIT ?`,
    )
    .bind(like, like, limit)
    .all<UserRow>();
  return result.results ?? [];
}

// Backs GET /api/search — published lessons matched by title, description, or
// tags. `tags` is stored as a JSON array string, so the LIKE match here is a
// substring match against that raw JSON text (same fields the old client-side
// filter checked, just across every published lesson instead of only loaded pages).
export async function searchPublishedLessons(
  db: D1Database,
  q: string,
  limit: number,
): Promise<LessonRow[]> {
  const like = `%${escapeLikePattern(q)}%`;
  const result = await db
    .prepare(
      `SELECT * FROM lessons
       WHERE status = 'published' AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')
       ORDER BY published_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(like, like, like, limit)
    .all<LessonRow>();
  return result.results ?? [];
}
