import type { LessonRow, SessionRow, UserRow } from "./types";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface UpsertUserParams {
  googleSub: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

// Keyed on google_sub (stable across logins); email/name/avatar refresh on
// every sign-in so profile changes on the Google side propagate here.
export async function upsertUserByGoogleSub(
  db: D1Database,
  params: UpsertUserParams,
): Promise<UserRow> {
  const row = await db
    .prepare(
      `INSERT INTO users (id, google_sub, email, name, avatar_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(google_sub) DO UPDATE SET
         email = excluded.email,
         name = excluded.name,
         avatar_url = excluded.avatar_url
       RETURNING *`,
    )
    .bind(
      crypto.randomUUID(),
      params.googleSub,
      params.email,
      params.name,
      params.avatarUrl,
      Date.now(),
    )
    .first<UserRow>();
  if (!row) {
    throw new Error("upsertUserByGoogleSub: INSERT ... RETURNING produced no row");
  }
  return row;
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
