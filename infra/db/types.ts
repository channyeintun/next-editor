import type { Lesson } from "../../tube/src/types";

export interface UserRow {
  id: string;
  google_sub: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  created_at: number;
}

/** Shape returned to the client (GET /api/auth/me) — no google_sub. */
export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export function userRowToAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
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
