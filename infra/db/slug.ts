// Shared slug-uniqueness helpers for the lessons and playlists create routes.
// Mirrors generateUniqueUsername in queries.ts: the bare slug is preferred and
// a numeric suffix is appended only when that slug is already taken.

type SluggedTable = "lessons" | "playlists";

export async function generateUniqueSlug(
  db: D1Database,
  table: SluggedTable,
  base: string,
): Promise<string> {
  for (let suffix = 0; ; suffix++) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    const existing = await db
      .prepare(`SELECT 1 FROM ${table} WHERE slug = ?`)
      .bind(candidate)
      .first();
    if (!existing) return candidate;
  }
}

// SQLite's own message format ("UNIQUE constraint failed: <table>.<column>"),
// stable across D1/wrangler versions since it comes from sqlite3 itself —
// same matching approach as isUniqueConstraintViolation in queries.ts.
export function isSlugUniqueViolation(error: unknown, table: SluggedTable): boolean {
  return String(error).includes(`UNIQUE constraint failed: ${table}.slug`);
}

// Bounds the insert-retry loops in the create routes: two concurrent creates
// with the same title can both pass generateUniqueSlug's read and race to
// INSERT; the loser retries with the next suffix. A persistent, unrelated
// failure should surface as an error rather than spin forever.
export const MAX_SLUG_INSERT_ATTEMPTS = 5;
