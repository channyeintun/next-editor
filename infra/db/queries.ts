import type { LessonRow, SessionRow, UserRow } from "./types";

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

function slugifyUsername(base: string): string {
  const slug = base
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "user";
}

// Generates a username unique against the DB by appending -2, -3, ... on
// collision. Only called once per user, at creation — see updateUsername
// below for renames (which also has to keep the lesson author_url cascade
// in sync, unlike this initial assignment).
async function generateUniqueUsername(db: D1Database, base: string): Promise<string> {
  const slug = slugifyUsername(base);
  for (let suffix = 0; ; suffix++) {
    const candidate = suffix === 0 ? slug : `${slug}-${suffix}`;
    const existing = await db
      .prepare("SELECT 1 FROM users WHERE username = ?")
      .bind(candidate)
      .first();
    if (!existing) return candidate;
  }
}

// SQLite's own message format ("UNIQUE constraint failed: <table>.<column>"),
// stable across D1/wrangler versions since it comes from sqlite3 itself — more
// specific than matching bare "UNIQUE", which would also match an unrelated
// column's collision (e.g. google_sub or email) on the same table.
function isUniqueConstraintViolation(error: unknown, column: string): boolean {
  return String(error).includes(`UNIQUE constraint failed: users.${column}`);
}

// Bounds the retry loop below: a persistent, unrelated failure should surface
// as an error rather than spin forever.
const MAX_USERNAME_INSERT_ATTEMPTS = 5;

// Keyed on google_sub (stable across logins); email/name/avatar refresh on
// every sign-in so profile changes on the Google side propagate here.
// username is only assigned here on first sign-in, never touched again by
// this function afterward — see updateUsername for user-initiated renames
// (unlike a single INSERT ... ON CONFLICT, this needs a read-then-write
// split so a new user's username can be looked up for uniqueness before the
// row exists).
export async function upsertUserByGoogleSub(
  db: D1Database,
  params: UpsertUserParams,
): Promise<UserRow> {
  const existing = await db
    .prepare("SELECT * FROM users WHERE google_sub = ?")
    .bind(params.googleSub)
    .first<UserRow>();

  if (existing) {
    const row = await db
      .prepare(
        `UPDATE users SET email = ?, name = ?, avatar_url = ?
         WHERE google_sub = ?
         RETURNING *`,
      )
      .bind(params.email, params.name, params.avatarUrl, params.googleSub)
      .first<UserRow>();
    if (!row) {
      throw new Error("upsertUserByGoogleSub: UPDATE ... RETURNING produced no row");
    }
    return row;
  }

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
      // the OAuth callback opened in two tabs) both pass the SELECT above and
      // race to INSERT; the loser hits the UNIQUE(google_sub) constraint. The
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
      if (
        !isUniqueConstraintViolation(error, "username") ||
        attempt >= MAX_USERNAME_INSERT_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
}

export async function createSession(db: D1Database, userId: string): Promise<SessionRow> {
  const now = Date.now();
  // Opportunistic cleanup: sweep this user's own expired sessions on every new
  // sign-in so the table doesn't grow unbounded (there's no separate cron for
  // this yet). Bounded to this user's rows only, so it stays cheap.
  await db
    .prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?")
    .bind(userId, now)
    .run();

  const session: SessionRow = {
    id: crypto.randomUUID(),
    user_id: userId,
    created_at: now,
    expires_at: now + SESSION_TTL_MS,
  };
  await db
    .prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(session.id, session.user_id, session.created_at, session.expires_at)
    .run();
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
      // requests, and routes/lessons.ts caches each page independently). A
      // tie straddling a page boundary then lands on both pages: the gallery
      // shows one lesson twice and silently never shows another.
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

export async function getUserByUsername(db: D1Database, username: string): Promise<UserRow | null> {
  const row = await db
    .prepare("SELECT * FROM users WHERE username = ?")
    .bind(username)
    .first<UserRow>();
  return row ?? null;
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
    if (isUniqueConstraintViolation(error, "username")) {
      return { status: "taken" };
    }
    throw error;
  }
}

// Backs the public author-profile view (/learn/@username for anyone but the
// owner) — published only, unlike listOwnedLessons.
export async function listPublishedLessonsByOwner(
  db: D1Database,
  ownerId: string,
): Promise<LessonRow[]> {
  const result = await db
    .prepare(
      "SELECT * FROM lessons WHERE owner_id = ? AND status = 'published' ORDER BY published_at DESC, id DESC",
    )
    .bind(ownerId)
    .all<LessonRow>();
  return result.results ?? [];
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
