// Test-only: a D1 stand-in over in-memory node:sqlite at the production
// schema, for the AthanLab breaker, credential, and route tests. Nothing in
// the Worker imports this module.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

export interface SqliteD1 {
  db: D1Database;
  sqlite: DatabaseSync;
}

export interface SqliteD1Options {
  /** Reject like a D1 outage: every statement, or those `failWhen` picks. */
  failWith?: Error;
  /** Reject only the statements whose SQL this returns true for. */
  failWhen?: (sql: string) => boolean;
}

/**
 * Every migration applied in the order wrangler applies them, with foreign
 * keys enforced as D1 enforces them. Statements behave as D1's do where the
 * Worker relies on it: `first()` runs the whole statement (an upsert's write
 * included) and returns its first row or null, and `meta.changes` counts the
 * rows the statement itself wrote — 0 for a conditional UPDATE or upsert whose
 * WHERE matched nothing, and 0 for a read (node:sqlite would report the
 * previous write's count there).
 */
export function openSqliteD1(options: SqliteD1Options = {}): SqliteD1 {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrations) {
    sqlite.exec(readFileSync(`${MIGRATIONS_DIR}${name}`, "utf8"));
  }

  const count = (sql: string) => Number((sqlite.prepare(sql).get() as { n: number | bigint }).n);
  const totalChanges = () => count("SELECT total_changes() AS n");
  /** What D1 reports as `meta.changes` for the statement run since `before`. */
  const changesSince = (before: number) =>
    totalChanges() === before ? 0 : count("SELECT changes() AS n");

  function statement(sql: string, args: unknown[] = []) {
    const guard = () => {
      if (options.failWhen ? options.failWhen(sql) : options.failWith) {
        throw options.failWith ?? new Error("D1_ERROR: storage unavailable");
      }
    };
    return {
      bind: (...bound: unknown[]) => statement(sql, bound),
      first: async () => {
        guard();
        return sqlite.prepare(sql).get(...(args as never[])) ?? null;
      },
      all: async () => {
        guard();
        const before = totalChanges();
        const results = sqlite.prepare(sql).all(...(args as never[]));
        return { success: true, results, meta: { changes: changesSince(before) } };
      },
      run: async () => {
        guard();
        const before = totalChanges();
        sqlite.prepare(sql).run(...(args as never[]));
        return { success: true, results: [], meta: { changes: changesSince(before) } };
      },
    };
  }

  return { db: { prepare: (sql: string) => statement(sql) } as unknown as D1Database, sqlite };
}

/** Insert a user with a session that outlives any test clock. */
export function insertSignedInUser(sqlite: DatabaseSync, userId: string, sessionId: string): void {
  sqlite
    .prepare(
      "INSERT INTO users (id, google_sub, email, username, created_at) VALUES (?, ?, ?, ?, 0)",
    )
    .run(userId, `google-${userId}`, `${userId}@example.com`, userId);
  sqlite
    .prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, 0, ?)")
    .run(sessionId, userId, Number.MAX_SAFE_INTEGER);
}
