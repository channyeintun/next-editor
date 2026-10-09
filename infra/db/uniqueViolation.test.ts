// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { isUniqueViolation } from "./uniqueViolation";

/** The error real SQLite raises for `sql`, which must break a UNIQUE constraint. */
function sqliteError(setup: string, sql: string): unknown {
  const db = new DatabaseSync(":memory:");
  db.exec(setup);
  try {
    db.exec(sql);
  } catch (error) {
    return error;
  }
  throw new Error(`expected ${sql} to fail`);
}

describe("isUniqueViolation", () => {
  it("matches the column SQLite names, and no other", () => {
    const error = sqliteError(
      "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, username TEXT UNIQUE);" +
        "INSERT INTO users VALUES ('u1', 'a@example.com', 'ada');",
      "INSERT INTO users VALUES ('u2', 'b@example.com', 'ada')",
    );

    expect(isUniqueViolation(error, "users.username")).toBe(true);
    expect(isUniqueViolation(error, "users.email")).toBe(false);
    expect(isUniqueViolation(error, "users.id")).toBe(false);
  });

  it("matches a composite key by its first column", () => {
    const error = sqliteError(
      "CREATE TABLE members (a TEXT, b TEXT, PRIMARY KEY (a, b)); INSERT INTO members VALUES ('x', 'y');",
      "INSERT INTO members VALUES ('x', 'y')",
    );

    expect(isUniqueViolation(error, "members.a")).toBe(true);
  });

  it("does not match other failures", () => {
    expect(isUniqueViolation(new Error("D1_ERROR: Network connection lost."), "users.id")).toBe(
      false,
    );
    expect(isUniqueViolation(undefined, "users.id")).toBe(false);
  });
});
