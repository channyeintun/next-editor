import { describe, expect, it } from "vite-plus/test";
import { searchRoute } from "./search";
import { openSqliteD1 } from "../../db/testing";

const COURSE_LENGTH = 30;

/**
 * The route against real SQLite at the production schema: a 30-lesson course
 * (published in order, so its last lesson is the newest), a newer lesson that
 * mentions CSS only in its description, a draft, the course's playlist, a
 * newer playlist that mentions CSS only in its description, and two that must
 * stay hidden (all-draft, and empty).
 */
function createEnv() {
  const { db, sqlite } = openSqliteD1();
  const lesson = (id: string, title: string, status: string, at: number, description = "") =>
    `('${id}', '${id}', 'owner', '${title}', '${description}', 'media/${id}.ne', '${status}', ${at}, 0, 0)`;
  const course = Array.from({ length: COURSE_LENGTH }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return lesson(`css-${n}`, `CSS course ${n}`, "published", i + 1);
  });
  sqlite.exec(`
    INSERT INTO users (id, google_sub, email, username, name, created_at)
      VALUES ('owner', 'google-owner', 'owner@example.com', 'chan', 'Chan', 0);
    INSERT INTO lessons (id, slug, owner_id, title, description, ne, status, published_at, created_at, updated_at) VALUES
      ${[
        ...course,
        lesson("selectors", "Selectors deep dive", "published", 100, "Every CSS selector"),
        lesson("css-draft", "CSS course draft", "draft", 0),
      ].join(",\n      ")};
    INSERT INTO playlists (id, slug, owner_id, title, description, created_at, updated_at) VALUES
      ('course', 'css-course', 'owner', 'CSS Course', NULL, 0, 0),
      ('extras', 'front-end-extras', 'owner', 'Front-end extras', 'More CSS', 0, 5),
      ('drafts', 'css-drafts', 'owner', 'CSS drafts', NULL, 0, 9),
      ('empty', 'css-empty', 'owner', 'Empty CSS list', NULL, 0, 9);
    INSERT INTO playlist_lessons (playlist_id, lesson_id, position, added_at) VALUES
      ('course', 'css-01', 0, 0), ('course', 'css-02', 1, 0), ('course', 'css-draft', 2, 0),
      ('extras', 'selectors', 0, 0),
      ('drafts', 'css-draft', 0, 0);
  `);
  return { DB: db } as never;
}

interface SearchBody {
  authors: { username: string }[];
  playlists: { slug: string; lessonCount: number }[];
  lessons: { slug: string }[];
  lessonTotal: number;
  nextPage: number | null;
}

async function get(env: never, query: string): Promise<SearchBody> {
  const res = await searchRoute.request(`https://nexteditor.dev/?${query}`, {}, env);
  expect(res.status).toBe(200);
  return res.json();
}

describe("GET /api/search", () => {
  it("answers lessons a page at a time, title matches first, with the total", async () => {
    const env = createEnv();

    const first = await get(env, "q=css");
    expect(first.lessonTotal).toBe(COURSE_LENGTH + 1);
    expect(first.lessons).toHaveLength(24);
    expect(first.lessons[0].slug).toBe("css-30");
    expect(first.nextPage).toBe(1);

    const second = await get(env, "q=css&page=1");
    // The description-only match is the newest lesson, but comes after every title match.
    expect(second.lessons.map((l) => l.slug)).toEqual([
      "css-06",
      "css-05",
      "css-04",
      "css-03",
      "css-02",
      "css-01",
      "selectors",
    ]);
    expect(second.nextPage).toBeNull();

    const all = [...first.lessons, ...second.lessons].map((l) => l.slug);
    expect(new Set(all).size).toBe(COURSE_LENGTH + 1);
    expect(all).not.toContain("css-draft");
  });

  it("offers authors and public playlists on page 0 only", async () => {
    const env = createEnv();

    const first = await get(env, "q=c");
    expect(first.authors.map((a) => a.username)).toEqual(["chan"]);
    // Only playlists with a published member, counting published members only.
    expect(first.playlists.map((p) => p.slug)).toEqual(["css-course", "front-end-extras"]);
    expect(first.playlists[0].lessonCount).toBe(2);

    const second = await get(env, "q=c&page=1");
    expect(second.authors).toEqual([]);
    expect(second.playlists).toEqual([]);
  });

  it("puts a playlist whose title matches ahead of a newer one matching only its description", async () => {
    const res = await get(createEnv(), "q=css");

    expect(res.playlists.map((p) => p.slug)).toEqual(["css-course", "front-end-extras"]);
  });

  it("answers a page past the end with no lessons and the real total", async () => {
    const res = await get(createEnv(), "q=css&page=5");

    expect(res.lessons).toEqual([]);
    expect(res.lessonTotal).toBe(COURSE_LENGTH + 1);
    expect(res.nextPage).toBeNull();
  });

  it("matches LIKE wildcards in the query literally", async () => {
    const res = await get(createEnv(), "q=css_course");

    expect(res.lessons).toEqual([]);
    expect(res.lessonTotal).toBe(0);
  });

  it.each(["-1", "1.5", "abc", "101", ""])("refuses page=%j", async (page) => {
    const res = await searchRoute.request(
      `https://nexteditor.dev/?q=css&page=${page}`,
      {},
      createEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("answers an empty query with nothing, without searching", async () => {
    await expect(get(createEnv(), "q=%20%20")).resolves.toEqual({
      authors: [],
      playlists: [],
      lessons: [],
      lessonTotal: 0,
      nextPage: null,
    });
  });
});
