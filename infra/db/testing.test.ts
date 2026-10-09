// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import { insertSignedInUser, openSqliteD1 } from "./testing";

// The suites that share this stand-in read D1's batch() contract from it, so
// pin the parts they rely on.
describe("openSqliteD1 batch()", () => {
  it("answers each statement's rows, RETURNING included, and its own changes", async () => {
    const { db, sqlite } = openSqliteD1();
    insertSignedInUser(sqlite, "user-1", "session-1");

    const [renamed, read, noop] = await db.batch<{ username: string }>([
      db
        .prepare("UPDATE users SET username = ? WHERE id = ? RETURNING username")
        .bind("ada", "user-1"),
      db.prepare("SELECT username FROM users WHERE id = ?").bind("user-1"),
      db.prepare("DELETE FROM sessions WHERE user_id = ?").bind("nobody"),
    ]);

    expect(renamed.results).toEqual([{ username: "ada" }]);
    expect(renamed.meta.changes).toBe(1);
    expect(read.results).toEqual([{ username: "ada" }]);
    expect(read.meta.changes).toBe(0);
    expect(noop.meta.changes).toBe(0);
  });

  it("rolls the whole batch back when one statement fails", async () => {
    const { db, sqlite } = openSqliteD1();
    insertSignedInUser(sqlite, "user-1", "session-1");

    await expect(
      db.batch([
        db.prepare("DELETE FROM sessions WHERE id = ?").bind("session-1"),
        db
          .prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, 0, 0)")
          .bind("session-2", "no-such-user"),
      ]),
    ).rejects.toThrow(/FOREIGN KEY/);

    expect(sqlite.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "session-1" }]);
  });

  it("runs a beforeNextBatch write ahead of the next batch only", async () => {
    const database = openSqliteD1();
    const { db, sqlite } = database;
    insertSignedInUser(sqlite, "user-1", "session-1");
    database.beforeNextBatch(() => {
      sqlite.prepare("DELETE FROM sessions WHERE id = ?").run("session-1");
    });

    const [first] = await db.batch([db.prepare("SELECT id FROM sessions")]);
    insertSignedInUser(sqlite, "user-2", "session-2");
    const [second] = await db.batch([db.prepare("SELECT id FROM sessions")]);

    expect(first.results).toEqual([]);
    expect(second.results).toEqual([{ id: "session-2" }]);
  });
});
