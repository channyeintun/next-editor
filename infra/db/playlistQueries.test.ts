// @vitest-environment node
import { describe, expect, it, vi } from "vite-plus/test";
import {
  addLessonToPlaylist,
  deletePlaylist,
  getPlaylistBySlug,
  removeLessonFromPlaylist,
  reorderPlaylistLessons,
} from "./playlistQueries";
import { openSqliteD1 } from "./testing";

/**
 * The playlist queries against real SQLite at the production schema, so the
 * ownership checks, each mutation's outcome and the public read's membership
 * come from the SQL itself.
 */
function createDb(): D1Database {
  const { db, sqlite } = openSqliteD1();
  sqlite.exec(`
    INSERT INTO users (id, google_sub, email, username, created_at)
      VALUES ('owner', 'google-owner', 'owner@example.com', 'owner', 0);
    INSERT INTO lessons (id, slug, owner_id, title, ne, status, created_at, updated_at) VALUES
      ('lesson-1', 'lesson-one', 'owner', 'Lesson one', 'media/lessons/lesson-1/lesson-1.ne', 'published', 0, 0),
      ('lesson-2', 'lesson-two', 'owner', 'Lesson two', 'media/lessons/lesson-2/lesson-2.ne', 'published', 0, 0);
    INSERT INTO playlists (id, slug, owner_id, title, created_at, updated_at)
      VALUES ('playlist-1', 'my-list', 'owner', 'My list', 0, 0);
  `);
  return db;
}

describe("playlist mutations", () => {
  it("succeed for the owner", async () => {
    const db = createDb();

    await expect(addLessonToPlaylist(db, "playlist-1", "owner", "lesson-1")).resolves.toEqual({
      status: "ok",
    });
    await addLessonToPlaylist(db, "playlist-1", "owner", "lesson-2");
    await expect(
      reorderPlaylistLessons(db, "playlist-1", "owner", ["lesson-2", "lesson-1"]),
    ).resolves.toBe(true);
    await expect(removeLessonFromPlaylist(db, "playlist-1", "owner", "lesson-1")).resolves.toBe(
      true,
    );
    await expect(deletePlaylist(db, "playlist-1", "owner")).resolves.toBe(true);
  });

  it("fail for anyone else, or a no-op", async () => {
    const db = createDb();

    await expect(addLessonToPlaylist(db, "playlist-1", "intruder", "lesson-1")).resolves.toEqual({
      status: "not_found",
    });
    await expect(reorderPlaylistLessons(db, "playlist-1", "intruder", [])).resolves.toBe(false);
    await expect(removeLessonFromPlaylist(db, "playlist-1", "owner", "lesson-1")).resolves.toBe(
      false,
    );
    await expect(deletePlaylist(db, "playlist-1", "intruder")).resolves.toBe(false);
    await expect(deletePlaylist(db, "playlist-1", "owner")).resolves.toBe(true);
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
