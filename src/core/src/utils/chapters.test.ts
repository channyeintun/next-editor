import { describe, expect, it } from "vite-plus/test";
import {
  chapterTitle,
  findChapterIndexAt,
  formatTimeParameter,
  MAX_CHAPTER_TITLE_LENGTH,
  normalizeChapters,
  parseTimeParameter,
} from "./chapters";

describe("chapters", () => {
  it("sorts them, keeps one per moment, and names the untitled", () => {
    expect(
      normalizeChapters([
        { time: 5_000, title: "  Routing " },
        { time: 0, title: "" },
        { time: 5_000, title: "Routing, again" },
        { time: Number.NaN, title: "broken" },
        { time: 1_000 },
        "junk",
        null,
      ]),
    ).toEqual([
      { time: 0, title: "Chapter 1" },
      { time: 5_000, title: "Routing, again" },
    ]);
  });

  it("cuts an overlong title", () => {
    const [chapter] = normalizeChapters([{ time: 0, title: "x".repeat(500) }]);
    expect(chapter.title).toHaveLength(MAX_CHAPTER_TITLE_LENGTH);
  });

  it("does not split an emoji when it cuts a title", () => {
    const [chapter] = normalizeChapters([{ time: 0, title: `${"a".repeat(119)}\u{1F600}` }]);
    expect(chapter.title).toBe("a".repeat(119));
  });

  it("trims a title, cuts it to the cap, and names an empty one by its place", () => {
    expect(chapterTitle("  Routing ", 0)).toBe("Routing");
    expect(chapterTitle("x".repeat(500), 0)).toBe("x".repeat(MAX_CHAPTER_TITLE_LENGTH));
    expect(chapterTitle(`${"a".repeat(119)}\u{1F600}`, 0)).toBe("a".repeat(119));
    expect(chapterTitle("   ", 2)).toBe("Chapter 3");
    expect(chapterTitle(undefined, 0)).toBe("Chapter 1");
  });

  it("finds the chapter playing at a moment", () => {
    const chapters = [
      { time: 0, title: "a" },
      { time: 5_000, title: "b" },
      { time: 9_000, title: "c" },
    ];
    expect(findChapterIndexAt(chapters, 0)).toBe(0);
    expect(findChapterIndexAt(chapters, 4_999)).toBe(0);
    expect(findChapterIndexAt(chapters, 5_000)).toBe(1);
    expect(findChapterIndexAt(chapters, 20_000)).toBe(2);
    expect(findChapterIndexAt([{ time: 3_000, title: "late" }], 1_000)).toBe(-1);
  });
});

describe("time links", () => {
  it.each([
    ["90", 90_000],
    ["90s", 90_000],
    ["12.5", 12_500],
    ["1:30", 90_000],
    ["1:02:03", 3_723_000],
    ["2m", 120_000],
    ["1h2m3s", 3_723_000],
    ["1M30S", 90_000],
  ])("reads %s", (value, expected) => {
    expect(parseTimeParameter(value)).toBe(expected);
  });

  it.each([
    null,
    "",
    "abc",
    "1:2:3:4",
    "-5",
    "5x",
    // Too long for a number: it would read as Infinity.
    "9".repeat(400),
    `${"9".repeat(400)}h`,
  ])("ignores %s", (value) => {
    expect(parseTimeParameter(value)).toBeNull();
  });

  it("writes whole seconds", () => {
    expect(formatTimeParameter(90_999)).toBe("90");
    expect(formatTimeParameter(-3)).toBe("0");
  });
});
