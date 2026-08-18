// Shared slug-uniqueness helpers for the lessons and playlists create routes.
// Mirrors generateUniqueUsername in queries.ts: the bare slug is preferred and
// a numeric suffix is appended only when that slug is already taken.

import seedManifest from "../../tube/data/lessons.json";

type SluggedTable = "lessons" | "playlists";

/**
 * Slugs the lesson catalog already answers for without a D1 row.
 *
 * Both resolvers — `infra/worker/lessonCatalog.ts` and `tube/src/lib/lessons.ts`
 * — check the build-time seed manifest *before* D1, deliberately and in the same
 * order. A D1-only uniqueness check therefore happily hands a new lesson a slug
 * the seed already owns, and that lesson is then unreachable at its own URL: a
 * lesson titled "Introduction" gets `introduction` and the built-in tour is
 * served in its place. Reserving them here fixes it at the source and leaves
 * both resolvers' seed-first order intact.
 */
const RESERVED_LESSON_SLUGS: ReadonlySet<string> = new Set(
  seedManifest.lessons.map((lesson) => lesson.slug),
);

function isReservedSlug(table: SluggedTable, candidate: string): boolean {
  return table === "lessons" && RESERVED_LESSON_SLUGS.has(candidate);
}

// Bounds the probe loop: the caller's title is attacker-controlled, so without a
// ceiling a run of same-titled lessons makes every later create walk the whole
// series one D1 round-trip at a time. Past the ceiling, fall back to a random
// suffix instead of probing forever.
const MAX_SLUG_SUFFIX_PROBES = 50;

export async function generateUniqueSlug(
  db: D1Database,
  table: SluggedTable,
  base: string,
): Promise<string> {
  for (let suffix = 0; suffix <= MAX_SLUG_SUFFIX_PROBES; suffix++) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    if (isReservedSlug(table, candidate)) continue;
    const existing = await db
      .prepare(`SELECT 1 FROM ${table} WHERE slug = ?`)
      .bind(candidate)
      .first();
    if (!existing) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
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
