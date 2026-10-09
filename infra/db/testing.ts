// Test-only: a D1 stand-in over in-memory node:sqlite at the production
// schema, shared by the db and Worker test suites (it lives here, not under
// infra/worker, because the db layer must not depend on the Worker). Nothing
// in the Worker or the db layer imports this module.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

export interface SqliteD1 {
  db: D1Database;
  sqlite: DatabaseSync;
  /**
   * Runs `write` just before the next batch starts, where another request's
   * commit can land after this request's pre-reads.
   */
  beforeNextBatch(write: () => void): void;
}

export interface SqliteD1Options {
  /** Reject like a D1 outage: every statement, or those `failWhen` picks. */
  failWith?: Error;
  /** Reject only the statements whose SQL this returns true for. */
  failWhen?: (sql: string) => boolean;
  /** Sees every statement the db runs, batched or not, with its arguments. */
  onStatement?: (sql: string, args: readonly unknown[]) => void;
}

interface StatementResult {
  success: true;
  results: unknown[];
  meta: { changes: number };
}

/**
 * Every migration applied in the order wrangler applies them, with foreign
 * keys enforced as D1 enforces them. Statements behave as D1's do where the
 * Worker relies on it: `first()` runs the whole statement (an upsert's write
 * included) and returns its first row or null, and `meta.changes` counts the
 * rows the statement itself wrote — 0 for a conditional UPDATE or upsert whose
 * WHERE matched nothing, and 0 for a read (node:sqlite would report the
 * previous write's count there). `batch()` runs its statements in order as one
 * transaction, rolled back whole when any of them fails, and answers each
 * statement's rows (a RETURNING clause's included) and its own `meta.changes`.
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

  /** How batch() runs a statement: synchronously, inside its transaction. */
  const runInBatch = new WeakMap<object, () => StatementResult>();
  let pendingWrite: (() => void) | null = null;

  function statement(sql: string, args: unknown[] = []) {
    const guard = () => {
      options.onStatement?.(sql, args);
      if (options.failWhen ? options.failWhen(sql) : options.failWith) {
        throw options.failWith ?? new Error("D1_ERROR: storage unavailable");
      }
    };
    const all = (): StatementResult => {
      guard();
      const before = totalChanges();
      const results = sqlite.prepare(sql).all(...(args as never[]));
      return { success: true, results, meta: { changes: changesSince(before) } };
    };
    const prepared = {
      bind: (...bound: unknown[]) => statement(sql, bound),
      first: async () => {
        guard();
        return sqlite.prepare(sql).get(...(args as never[])) ?? null;
      },
      all: async () => all(),
      run: async () => {
        guard();
        const before = totalChanges();
        sqlite.prepare(sql).run(...(args as never[]));
        return { success: true, results: [], meta: { changes: changesSince(before) } };
      },
    };
    runInBatch.set(prepared, all);
    return prepared;
  }

  async function batch(statements: object[]): Promise<StatementResult[]> {
    const write = pendingWrite;
    pendingWrite = null;
    write?.();
    sqlite.exec("BEGIN");
    try {
      const results = statements.map((entry) => {
        const run = runInBatch.get(entry);
        if (!run) throw new Error("batch() was given a statement from another database");
        return run();
      });
      sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    db: { prepare: (sql: string) => statement(sql), batch } as unknown as D1Database,
    sqlite,
    beforeNextBatch(write) {
      pendingWrite = write;
    },
  };
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
