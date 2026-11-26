// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import { listGalleryCards } from "./galleryQueries";
import { openSqliteD1 } from "./testing";
import { galleryCardRowToItem } from "./types";

/**
 * The gallery's cards against real SQLite at the production schema, so which
 * lessons a playlist replaces, where the playlist stands and how the pages
 * divide all come from the SQL itself.
 */

interface LessonSeed {
  id: string;
  publishedAt: number;
  status?: "draft" | "published";
}

function createDb(lessons: LessonSeed[], playlists: Record<string, string[]> = {}): D1Database {
  const { db, sqlite } = openSqliteD1();
  sqlite.exec(`
    INSERT INTO users (id, google_sub, email, name, username, created_at)
      VALUES ('owner', 'google-owner', 'owner@example.com', 'Hla Hla', 'hla', 0);
  `);
  const insertLesson = sqlite.prepare(
    `INSERT INTO lessons
       (id, slug, owner_id, title, thumbnail, ne, status, published_at, created_at, updated_at)
     VALUES (?, ?, 'owner', ?, ?, ?, ?, ?, 0, 0)`,
  );
  for (const lesson of lessons) {
    const published = (lesson.status ?? "published") === "published";
    insertLesson.run(
      lesson.id,
      `slug-${lesson.id}`,
      `Lesson ${lesson.id}`,
      `media/lessons/${lesson.id}/thumb.webp`,
      `media/lessons/${lesson.id}/${lesson.id}.ne`,
      published ? "published" : "draft",
      published ? lesson.publishedAt : null,
    );
  }
  const insertPlaylist = sqlite.prepare(
    `INSERT INTO playlists (id, slug, owner_id, title, created_at, updated_at)
     VALUES (?, ?, 'owner', ?, 0, 0)`,
  );
  const insertMember = sqlite.prepare(
    "INSERT INTO playlist_lessons (playlist_id, lesson_id, position, added_at) VALUES (?, ?, ?, 0)",
  );
  for (const [id, members] of Object.entries(playlists)) {
    insertPlaylist.run(id, `list-${id}`, `Playlist ${id}`);
    members.forEach((lessonId, position) => insertMember.run(id, lessonId, position));
  }
  return db;
}

/** Each card as "playlist:<slug>" or "lesson:<slug>", in page order. */
async function cards(db: D1Database, page = 0, pageSize = 12): Promise<string[]> {
  const { rows } = await listGalleryCards(db, page, pageSize);
  return rows.map((row) => {
    const item = galleryCardRowToItem(row);
    return item.kind === "lesson" ? `lesson:${item.lesson.slug}` : `playlist:${item.playlist.slug}`;
  });
}

describe("listGalleryCards", () => {
  it("shows a playlist in place of the lessons it holds, and the other lessons on their own", async () => {
    const db = createDb(
      [
        { id: "a", publishedAt: 50 },
        { id: "b", publishedAt: 40 },
        { id: "c", publishedAt: 30 },
        { id: "d", publishedAt: 20 },
      ],
      { rust: ["b", "d"] },
    );

    expect(await cards(db)).toEqual(["lesson:slug-a", "playlist:list-rust", "lesson:slug-c"]);
  });

  it("places a playlist where its newest published lesson would have been", async () => {
    const db = createDb(
      [
        { id: "old", publishedAt: 10 },
        { id: "new", publishedAt: 90 },
        { id: "alone", publishedAt: 50 },
        { id: "css-1", publishedAt: 30 },
      ],
      { rust: ["old", "new"], css: ["css-1"] },
    );

    expect(await cards(db)).toEqual([
      "playlist:list-rust",
      "lesson:slug-alone",
      "playlist:list-css",
    ]);
  });

  it("carries what each card shows", async () => {
    const db = createDb(
      [
        { id: "alone", publishedAt: 50 },
        { id: "first", publishedAt: 20 },
        { id: "second", publishedAt: 30 },
        { id: "draft", publishedAt: 0, status: "draft" },
      ],
      { rust: ["draft", "first", "second"] },
    );

    const { rows } = await listGalleryCards(db, 0, 12);

    expect(rows.map(galleryCardRowToItem)).toEqual([
      {
        kind: "lesson",
        lesson: expect.objectContaining({
          slug: "slug-alone",
          title: "Lesson alone",
          ne: "media/lessons/alone/alone.ne",
        }),
      },
      {
        kind: "playlist",
        playlist: {
          slug: "list-rust",
          title: "Playlist rust",
          description: "",
          // Published members only, and the first of them is the cover.
          lessonCount: 2,
          thumbnail: "media/lessons/first/thumb.webp",
          author: "Hla Hla",
          authorUrl: "/learn/@hla",
        },
      },
    ]);
  });

  it("leaves out a playlist with no published lesson, and keeps its drafts out too", async () => {
    const db = createDb(
      [
        { id: "alone", publishedAt: 50 },
        { id: "draft", publishedAt: 0, status: "draft" },
      ],
      { empty: [], drafts: ["draft"] },
    );

    expect(await cards(db)).toEqual(["lesson:slug-alone"]);
  });

  it("shows every playlist a lesson is in, and the lesson in neither's place", async () => {
    const db = createDb([{ id: "shared", publishedAt: 50 }], {
      rust: ["shared"],
      basics: ["shared"],
    });

    expect(await cards(db)).toEqual(["playlist:list-rust", "playlist:list-basics"]);
  });

  it("returns every card exactly once across pages, ties included", async () => {
    // A bulk publish: every lesson, and so every playlist, at the same millisecond.
    const lessons = ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({ id, publishedAt: 100 }));
    const playlists = { one: ["a", "b"], two: ["c"] };
    const natural = createDb(lessons, playlists);
    const shuffled = createDb([...lessons].reverse(), { two: ["c"], one: ["a", "b"] });

    // Page 0 and page 1 are separate requests; read each from a database that
    // stores the tied rows the other way round.
    const first = await listGalleryCards(natural, 0, 3);
    const second = await listGalleryCards(shuffled, 1, 3);
    const all = [...(await cards(natural, 0, 3)), ...(await cards(shuffled, 1, 3))];

    expect(first.nextPage).toBe(1);
    expect(second.nextPage).toBeNull();
    expect([...all].sort()).toEqual([
      "lesson:slug-d",
      "lesson:slug-e",
      "lesson:slug-f",
      "lesson:slug-g",
      "playlist:list-one",
      "playlist:list-two",
    ]);
  });

  it("answers an offset past the int64 range with an empty page instead of failing", async () => {
    const db = {
      prepare() {
        throw new Error("the statement must not be issued for an unbindable offset");
      },
    } as unknown as D1Database;

    await expect(listGalleryCards(db, 1e300, 12)).resolves.toEqual({ rows: [], nextPage: null });
  });
});
