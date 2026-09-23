// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  addLessonToPlaylist,
  deletePlaylist,
  removeLessonFromPlaylist,
  reorderPlaylistLessons,
} from "./playlistQueries";

/**
 * The playlist mutations against real SQLite, so the ownership checks and the
 * slug each one answers with (the KV key the route invalidates) come from the
 * SQL itself. Only the columns these statements touch are created.
 */
function createDb(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE lessons (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE playlists (
      id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, owner_id TEXT NOT NULL, updated_at INTEGER
    );
    CREATE TABLE playlist_lessons (
      playlist_id TEXT NOT NULL, lesson_id TEXT NOT NULL, position INTEGER NOT NULL,
      added_at INTEGER NOT NULL, PRIMARY KEY (playlist_id, lesson_id)
    );
    INSERT INTO lessons VALUES ('lesson-1', 'owner', 'published'), ('lesson-2', 'owner', 'published');
    INSERT INTO playlists VALUES ('playlist-1', 'my-list', 'owner', 0);
  `);

  function statement(sql: string, args: unknown[] = []) {
    const run = () => {
      const result = db.prepare(sql).run(...(args as never[]));
      return { meta: { changes: Number(result.changes) } };
    };
    return {
      bind: (...bound: unknown[]) => statement(sql, bound),
      first: async () => db.prepare(sql).get(...(args as never[])) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
      run: async () => run(),
      runNow: run,
    };
  }

  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<ReturnType<typeof statement>>) =>
      statements.map((entry) => entry.runNow()),
  } as unknown as D1Database;
}

describe("playlist mutations", () => {
  it("answer the owner with the playlist's slug", async () => {
    const db = createDb();

    await expect(addLessonToPlaylist(db, "playlist-1", "owner", "lesson-1")).resolves.toEqual({
      status: "ok",
      slug: "my-list",
    });
    await addLessonToPlaylist(db, "playlist-1", "owner", "lesson-2");
    await expect(
      reorderPlaylistLessons(db, "playlist-1", "owner", ["lesson-2", "lesson-1"]),
    ).resolves.toBe("my-list");
    await expect(removeLessonFromPlaylist(db, "playlist-1", "owner", "lesson-1")).resolves.toBe(
      "my-list",
    );
    await expect(deletePlaylist(db, "playlist-1", "owner")).resolves.toBe("my-list");
  });

  it("answer anyone else, or a no-op, with nothing", async () => {
    const db = createDb();

    await expect(addLessonToPlaylist(db, "playlist-1", "intruder", "lesson-1")).resolves.toEqual({
      status: "not_found",
    });
    await expect(reorderPlaylistLessons(db, "playlist-1", "intruder", [])).resolves.toBeNull();
    await expect(
      removeLessonFromPlaylist(db, "playlist-1", "owner", "lesson-1"),
    ).resolves.toBeNull();
    await expect(deletePlaylist(db, "playlist-1", "intruder")).resolves.toBeNull();
    await expect(deletePlaylist(db, "playlist-1", "owner")).resolves.toBe("my-list");
  });
});
