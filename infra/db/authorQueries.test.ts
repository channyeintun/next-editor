// @vitest-environment node
import { describe, expect, it, vi } from "vite-plus/test";
import { getPublishedAuthorProfile } from "./authorQueries";
import { publishedPlaylistsByOwnerStatement } from "./playlistQueries";
import { publishedLessonsByOwnerStatement, USERNAME_PATTERN } from "./queries";
import { openSqliteD1 } from "./testing";

/**
 * The public author profile against real SQLite at the production schema, so
 * the username subselects, the published-only filters and the ordering come
 * from the SQL itself.
 */
function createDb() {
  const { db, sqlite } = openSqliteD1();
  sqlite.exec(`
    INSERT INTO users (id, google_sub, email, username, created_at) VALUES
      ('ada-id', 'google-ada', 'ada@example.com', 'ada', 0),
      ('bob-id', 'google-bob', 'bob@example.com', 'bob', 0);
    INSERT INTO lessons (id, slug, owner_id, title, ne, status, published_at, created_at, updated_at) VALUES
      ('older', 'older', 'ada-id', 'Older', 'older.ne', 'published', 100, 0, 0),
      ('tie-a', 'tie-a', 'ada-id', 'Tie A', 'tie-a.ne', 'published', 200, 0, 0),
      ('tie-b', 'tie-b', 'ada-id', 'Tie B', 'tie-b.ne', 'published', 200, 0, 0),
      ('draft', 'draft', 'ada-id', 'Draft', 'draft.ne', 'draft', NULL, 0, 0),
      ('bobs', 'bobs', 'bob-id', 'Bob''s', 'bobs.ne', 'published', 300, 0, 0);
    INSERT INTO playlists (id, slug, owner_id, title, created_at, updated_at) VALUES
      ('mixed', 'mixed', 'ada-id', 'Mixed', 0, 10),
      ('drafts-only', 'drafts-only', 'ada-id', 'Drafts only', 0, 30),
      ('published', 'published', 'ada-id', 'Published', 0, 20),
      ('bobs-list', 'bobs-list', 'bob-id', 'Bob''s list', 0, 40);
    INSERT INTO playlist_lessons (playlist_id, lesson_id, position, added_at) VALUES
      ('mixed', 'draft', 0, 0),
      ('mixed', 'older', 1, 0),
      ('drafts-only', 'draft', 0, 0),
      ('published', 'tie-a', 0, 0),
      ('bobs-list', 'bobs', 0, 0);
  `);
  return { db, sqlite };
}

describe("getPublishedAuthorProfile", () => {
  it("answers the user with their published lessons and playlists, in one batch", async () => {
    const { db } = createDb();
    const batch = vi.spyOn(db, "batch");

    const profile = await getPublishedAuthorProfile(db, "ada");

    expect(profile?.user).toMatchObject({ id: "ada-id", username: "ada" });
    expect(profile?.lessons.map((lesson) => lesson.id)).toEqual(["tie-b", "tie-a", "older"]);
    expect(
      profile?.playlists.map(({ id, lesson_count, first_lesson_thumbnail }) => ({
        id,
        lesson_count,
        first_lesson_thumbnail,
      })),
    ).toEqual([
      { id: "published", lesson_count: 1, first_lesson_thumbnail: null },
      { id: "mixed", lesson_count: 1, first_lesson_thumbnail: null },
    ]);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("answers an author with nothing published with empty lists", async () => {
    const { db, sqlite } = createDb();
    sqlite.exec("UPDATE lessons SET status = 'draft' WHERE owner_id = 'ada-id'");

    await expect(getPublishedAuthorProfile(db, "ada")).resolves.toMatchObject({
      user: { id: "ada-id" },
      lessons: [],
      playlists: [],
    });
  });

  it("answers null for an unknown username", async () => {
    await expect(getPublishedAuthorProfile(createDb().db, "nobody")).resolves.toBeNull();
  });

  // Older accounts keep names outside USERNAME_PATTERN on purpose (see its
  // doc). Lookups must stay exact matches: validating the pattern here would
  // break every profile and author link those names already have.
  it("still resolves usernames issued before the rename rule", async () => {
    const legacy = ["jo", "maximilian-alexander-von-habsburg-lothringen", "100%-sure-66666666"];
    const { db, sqlite } = createDb();
    for (const [index, username] of legacy.entries()) {
      sqlite
        .prepare(
          `INSERT INTO users (id, google_sub, email, username, created_at)
           VALUES (?, ?, ?, ?, 0)`,
        )
        .run(`user-${index}`, `google-${index}`, `${index}@example.com`, username);
      sqlite
        .prepare(
          `INSERT INTO lessons (id, slug, owner_id, title, ne, status, published_at, created_at, updated_at)
           VALUES (?, ?, ?, 'Legacy', 'legacy.ne', 'published', 1, 0, 0)`,
        )
        .run(`legacy-${index}`, `legacy-${index}`, `user-${index}`);
    }

    for (const [index, username] of legacy.entries()) {
      expect(username).not.toMatch(USERNAME_PATTERN);
      const profile = await getPublishedAuthorProfile(db, username);
      expect(profile?.user).toMatchObject({ id: `user-${index}`, username });
      expect(profile?.lessons.map((lesson) => lesson.id)).toEqual([`legacy-${index}`]);
    }
  });
});

describe("published-by-owner statements", () => {
  it("select the same rows by user id as by username", async () => {
    const { db } = createDb();
    const ids = async (statement: D1PreparedStatement) =>
      (await statement.all<{ id: string }>()).results.map((row) => row.id);

    expect(await ids(publishedLessonsByOwnerStatement(db, { id: "ada-id" }))).toEqual(
      await ids(publishedLessonsByOwnerStatement(db, { username: "ada" })),
    );
    expect(await ids(publishedPlaylistsByOwnerStatement(db, { id: "ada-id" }))).toEqual(
      await ids(publishedPlaylistsByOwnerStatement(db, { username: "ada" })),
    );
  });
});
