// The one home of the "first free suffix" lookup that generateUniqueUsername
// (queries.ts) and generateUniqueSlug (slug.ts) share: each builds its ordered
// candidate list (the bare name first, then -1, -2 …) and asks here which one
// no row holds yet.

/**
 * The unique columns a generated name is checked against. A closed union, so
 * the table and column spliced into the SQL never come from input.
 */
export type UniqueColumn = "users.username" | "lessons.slug" | "playlists.slug";

/**
 * The first of `candidates`, in order, that no row of `column` holds, or null
 * when every one is taken. All of them are checked in one query, one D1 round
 * trip, rather than one awaited SELECT per candidate. D1 allows 100 bound
 * parameters per query, so callers keep the list well under that (51 today).
 *
 * This is a read: a concurrent INSERT can still take the answer before the
 * caller writes it, which the callers' UNIQUE-violation retries cover.
 */
export async function firstFreeCandidate(
  db: D1Database,
  column: UniqueColumn,
  candidates: readonly string[],
): Promise<string | null> {
  if (candidates.length === 0) return null;
  const [table, field] = column.split(".");
  const placeholders = candidates.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT ${field} AS v FROM ${table} WHERE ${field} IN (${placeholders})`)
    .bind(...candidates)
    .all<{ v: string }>();
  const taken = new Set(results.map((row) => row.v));
  return candidates.find((candidate) => !taken.has(candidate)) ?? null;
}
