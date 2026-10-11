// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import { firstFreeCandidate } from "./firstFreeCandidate";
import { openSqliteD1 } from "./testing";

/** A database at the production schema whose users table holds `taken`. */
function makeDb(taken: string[]) {
  const statements: string[] = [];
  const { db, sqlite } = openSqliteD1({ onStatement: (sql) => statements.push(sql) });
  const insert = sqlite.prepare(
    "INSERT INTO users (id, google_sub, email, username, created_at) VALUES (?, ?, ?, ?, 0)",
  );
  for (const [index, username] of taken.entries()) {
    insert.run(`taken-${index}`, `google-${index}`, `taken-${index}@example.com`, username);
  }
  return { db, statements };
}

describe("firstFreeCandidate", () => {
  it("answers the first candidate in order that no row holds, in one query", async () => {
    const { db, statements } = makeDb(["ada", "ada-1", "ada-3"]);

    await expect(
      firstFreeCandidate(db, "users.username", ["ada", "ada-1", "ada-2", "ada-3", "ada-4"]),
    ).resolves.toBe("ada-2");
    expect(statements).toHaveLength(1);
  });

  it("answers null when every candidate is taken", async () => {
    const { db } = makeDb(["ada", "ada-1"]);

    await expect(firstFreeCandidate(db, "users.username", ["ada", "ada-1"])).resolves.toBeNull();
  });

  it("answers null for no candidates without querying", async () => {
    const { db, statements } = makeDb([]);

    await expect(firstFreeCandidate(db, "users.username", [])).resolves.toBeNull();
    expect(statements).toHaveLength(0);
  });
});
