import type { LessonRow, SessionRow, UserRow } from "./types";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
// collision. Only called once per user, at creation — usernames never
// change afterward, since they're baked into lesson author_url links.
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

// Keyed on google_sub (stable across logins); email/name/avatar refresh on
// every sign-in so profile changes on the Google side propagate here.
// username is generated once, on first sign-in, and never touched again by
// this function (unlike a single INSERT ... ON CONFLICT, this needs a
// read-then-write split so a new user's username can be looked up for
// uniqueness before the row exists).
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

  const username = await generateUniqueUsername(db, params.name ?? params.email.split("@")[0]);
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
    if (!row) throw error;
    return row;
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
  const result = await db
    .prepare(
      "SELECT * FROM lessons WHERE status = 'published' ORDER BY published_at DESC LIMIT ? OFFSET ?",
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
    return getLessonById(db, id);
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

// Backs the public author-profile view (/learn/@username for anyone but the
// owner) — published only, unlike listOwnedLessons.
export async function listPublishedLessonsByOwner(
  db: D1Database,
  ownerId: string,
): Promise<LessonRow[]> {
  const result = await db
    .prepare(
      "SELECT * FROM lessons WHERE owner_id = ? AND status = 'published' ORDER BY published_at DESC",
    )
    .bind(ownerId)
    .all<LessonRow>();
  return result.results ?? [];
}

// Backs GET /api/search — authors matched by username or display name.
export async function searchUsers(db: D1Database, q: string, limit: number): Promise<UserRow[]> {
  const like = `%${q}%`;
  const result = await db
    .prepare("SELECT * FROM users WHERE username LIKE ? OR name LIKE ? ORDER BY name LIMIT ?")
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
  const like = `%${q}%`;
  const result = await db
    .prepare(
      `SELECT * FROM lessons
       WHERE status = 'published' AND (title LIKE ? OR description LIKE ? OR tags LIKE ?)
       ORDER BY published_at DESC
       LIMIT ?`,
    )
    .bind(like, like, like, limit)
    .all<LessonRow>();
  return result.results ?? [];
}
