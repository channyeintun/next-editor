// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import { galleryRoute } from "./gallery";
import { openSqliteD1 } from "../../db/testing";

/**
 * The route against real SQLite at the production schema: a four-lesson course
 * in a playlist, a newer lesson and an older one in no playlist, and a draft.
 */
function createEnv() {
  const { db, sqlite } = openSqliteD1();
  const lesson = (id: string, status: string, at: number | null) =>
    `('${id}', '${id}', 'owner', 'Lesson ${id}', 'media/${id}.webp', 'media/${id}.ne', '${status}', ${at}, 0, 0)`;
  sqlite.exec(`
    INSERT INTO users (id, google_sub, email, username, name, created_at)
      VALUES ('owner', 'google-owner', 'owner@example.com', 'chan', 'Chan', 0);
    INSERT INTO lessons (id, slug, owner_id, title, thumbnail, ne, status, published_at, created_at, updated_at) VALUES
      ${[
        lesson("css-1", "published", 10),
        lesson("css-2", "published", 20),
        lesson("css-3", "published", 30),
        lesson("css-4", "published", 40),
        lesson("kite", "published", 50),
        lesson("intro", "published", 5),
        lesson("draft", "draft", null),
      ].join(",\n      ")};
    INSERT INTO playlists (id, slug, owner_id, title, created_at, updated_at)
      VALUES ('course', 'css-course', 'owner', 'CSS Course', 0, 0);
    INSERT INTO playlist_lessons (playlist_id, lesson_id, position, added_at) VALUES
      ('course', 'css-1', 0, 0), ('course', 'css-2', 1, 0),
      ('course', 'css-3', 2, 0), ('course', 'css-4', 3, 0);
  `);
  return { DB: db } as never;
}

function get(query: string) {
  return galleryRoute.request(`https://nexteditor.dev/${query}`, {}, createEnv());
}

describe("GET /api/gallery", () => {
  it("answers the playlist in place of its lessons, among the lessons in no playlist", async () => {
    const response = await get("");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        { kind: "lesson", lesson: expect.objectContaining({ slug: "kite", ne: "media/kite.ne" }) },
        {
          kind: "playlist",
          playlist: {
            slug: "css-course",
            title: "CSS Course",
            description: "",
            lessonCount: 4,
            thumbnail: "media/css-1.webp",
            author: "Chan",
            authorUrl: "/learn/@chan",
          },
        },
        { kind: "lesson", lesson: expect.objectContaining({ slug: "intro" }) },
      ],
      nextPage: null,
    });
  });

  it("answers a page past the end with an empty page", async () => {
    const response = await get("?page=500");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], nextPage: null });
  });

  it.each(["-1", "1.5", "abc"])("refuses ?page=%s", async (page) => {
    const response = await get(`?page=${page}`);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid page" });
  });
});
