// SQLite's own message format ("UNIQUE constraint failed: <table>.<column>"),
// stable across D1/wrangler versions since it comes from sqlite3 itself. Name
// the qualified column: matching bare "UNIQUE" would also match an unrelated
// column's collision (e.g. google_sub or email) on the same table. A composite
// PRIMARY KEY or UNIQUE reports every column ("t.a, t.b"), so its first column
// matches it.
export function isUniqueViolation(error: unknown, qualifiedColumn: string): boolean {
  return String(error).includes(`UNIQUE constraint failed: ${qualifiedColumn}`);
}
