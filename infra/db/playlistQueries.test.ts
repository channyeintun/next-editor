// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  addLessonToPlaylist,
  deletePlaylist,
  getPlaylistBySlug,
  removeLessonFromPlaylist,
  reorderPlaylistLessons,
} from "./playlistQueries";

/**
 * The playlist queries against real SQLite, so the ownership checks, the slug
 * each mutation answers with and the public read's membership come from the SQL
 * itself. Only the columns these statements touch are created.
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
    // A batched SELECT answers with its rows, as D1's batch() does.
    const run = () => {
      if (/^\s*SELECT\b/i.test(sql)) {
        return { results: db.prepare(sql).all(...(args as never[])), meta: { changes: 0 } };
      }
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

  it("answer a second add of the same lesson with already_added", async () => {
    const db = createDb();
    await addLessonToPlaylist(db, "playlist-1", "owner", "lesson-1");

    await expect(addLessonToPlaylist(db, "playlist-1", "owner", "lesson-1")).resolves.toEqual({
      status: "already_added",
    });
  });
});

describe("getPlaylistBySlug", () => {
  it("answers the playlist and its published members in position order, in one batch", async () => {
    const db = createDb();
    await addLessonToPlaylist(db, "playlist-1", "owner", "lesson-1");
    await addLessonToPlaylist(db, "playlist-1", "owner", "lesson-2");
    await reorderPlaylistLessons(db, "playlist-1", "owner", ["lesson-2", "lesson-1"]);
    const batch = vi.spyOn(db, "batch");

    const result = await getPlaylistBySlug(db, "my-list");

    expect(result?.playlist).toMatchObject({ id: "playlist-1", slug: "my-list" });
    expect(result?.lessons.map((lesson) => lesson.id)).toEqual(["lesson-2", "lesson-1"]);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("leaves out a member that is no longer published", async () => {
    const db = createDb();
    await addLessonToPlaylist(db, "playlist-1", "owner", "lesson-1");
    await addLessonToPlaylist(db, "playlist-1", "owner", "lesson-2");
    await db.prepare("UPDATE lessons SET status = 'draft' WHERE id = ?").bind("lesson-1").run();

    const result = await getPlaylistBySlug(db, "my-list");

    expect(result?.lessons.map((lesson) => lesson.id)).toEqual(["lesson-2"]);
  });

  it("answers an empty playlist with no members", async () => {
    const result = await getPlaylistBySlug(createDb(), "my-list");

    expect(result).toMatchObject({ playlist: { slug: "my-list" }, lessons: [] });
  });

  it("answers null for an unknown slug", async () => {
    await expect(getPlaylistBySlug(createDb(), "nope")).resolves.toBeNull();
  });
});
