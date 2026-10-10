import { describe, expect, it } from "vite-plus/test";
import type { Lesson } from "./types";
import { FIRST_LESSONS_PAGE, lessonsPageIndex, toLessonsPage } from "./lessonsPages";

function lesson(slug: string): Lesson {
  return { slug, title: slug, description: "", thumbnail: "", ne: `${slug}.ne` };
}

const SEED = [lesson("introduction")];

describe("toLessonsPage", () => {
  it("gives a page with more after it the next page's cursor and leaves the seed out", () => {
    expect(toLessonsPage({ lessons: [lesson("newest")], nextPage: 1 }, SEED)).toEqual({
      lessons: [lesson("newest")],
      nextPage: "d1:1",
    });
  });

  it("appends the seed to the last page, an empty catalog's only page included", () => {
    expect(toLessonsPage({ lessons: [lesson("oldest")], nextPage: null }, SEED)).toEqual({
      lessons: [lesson("oldest"), lesson("introduction")],
      nextPage: null,
    });
    expect(toLessonsPage({ lessons: [], nextPage: null }, SEED).lessons).toEqual(SEED);
  });
});

describe("lessonsPageIndex", () => {
  it("reads the D1 page a cursor names, from the first page's on", () => {
    expect(lessonsPageIndex(FIRST_LESSONS_PAGE)).toBe(0);
    expect(lessonsPageIndex("d1:3")).toBe(3);
  });

  it("starts from the first page for anything else", () => {
    expect(lessonsPageIndex("seed:2")).toBe(0);
    expect(lessonsPageIndex("d1:nope")).toBe(0);
  });
});
