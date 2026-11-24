import { describe, expect, it } from "vite-plus/test";
import {
  lessonScriptReaderFiles,
  liveIndexMovedProblem,
  planPublish,
  type DefaultLesson,
} from "./publishPlan";
import {
  encodePublishedScriptIndex,
  parsePublishedScriptIndex,
  type PublishedScriptEntry,
  type PublishedScriptIndex,
} from "./publishedScripts";

const id = (digit: string) => digit.repeat(64);

function entry(digit: string, locale = "en-US"): PublishedScriptEntry {
  return { id: id(digit), bytes: 10, title: `Lesson ${digit}`, locale, runtimeMode: "live" };
}

function index(
  source: string,
  lessons: Record<string, PublishedScriptEntry>,
): PublishedScriptIndex {
  return { version: 1, source, lessons };
}

/** The live index as the bucket holds it: its stored text, read back. */
function liveOf(value: PublishedScriptIndex) {
  const text = encodePublishedScriptIndex(value);
  return { index: parsePublishedScriptIndex(JSON.parse(text)), text };
}

const DEFAULTS: DefaultLesson[] = [
  { slug: "burmese", language: "my" },
  { slug: "english", language: "en" },
];
const base = { burmese: entry("1", "my"), english: entry("2") };

describe("planPublish", () => {
  it("puts every object and the index on a first publish", () => {
    const next = index("c1", { ...base, extra: entry("3") });
    const plan = planPublish({ next, live: null, allowRemovals: false, defaultLessons: DEFAULTS });
    expect(plan.refusals).toEqual([]);
    expect(plan.puts).toEqual([id("1"), id("2"), id("3")]);
    expect(plan.putIndex).toBe(true);
    expect(plan.indexText).toBe(encodePublishedScriptIndex(next));
    expect(plan.added).toEqual(["burmese", "english", "extra"]);
  });

  it("puts only the objects the live index does not name, each once", () => {
    const live = liveOf(index("c1", base));
    const next = index("c2", {
      ...base,
      changed: entry("4"),
      copy: entry("4"),
      english: entry("5"),
    });
    const plan = planPublish({ next, live, allowRemovals: false, defaultLessons: DEFAULTS });
    expect(plan.puts).toEqual([id("4"), id("5")]);
    expect(plan.added).toEqual(["changed", "copy"]);
    expect(plan.changed).toEqual(["english"]);
    expect(plan.removed).toEqual([]);
    expect(plan.putIndex).toBe(true);
  });

  it("puts nothing when the live index is already these bytes", () => {
    const next = index("c1", base);
    const plan = planPublish({
      next,
      live: liveOf(next),
      allowRemovals: false,
      defaultLessons: DEFAULTS,
    });
    expect(plan).toMatchObject({ puts: [], putIndex: false, refusals: [] });
  });

  it("puts the index alone when only the source commit moved", () => {
    const plan = planPublish({
      next: index("c2", base),
      live: liveOf(index("c1", base)),
      allowRemovals: false,
      defaultLessons: DEFAULTS,
    });
    expect(plan).toMatchObject({ puts: [], putIndex: true, refusals: [] });
  });

  it("refuses to drop a published lesson unless removals are allowed", () => {
    const live = liveOf(index("c1", { ...base, gone: entry("3") }));
    const next = index("c2", base);
    const refused = planPublish({ next, live, allowRemovals: false, defaultLessons: DEFAULTS });
    expect(refused.removed).toEqual(["gone"]);
    expect(refused.refusals).toEqual([
      "1 published lesson(s) would disappear: gone (--allow-removals removes them)",
    ]);
    const allowed = planPublish({ next, live, allowRemovals: true, defaultLessons: DEFAULTS });
    expect(allowed.refusals).toEqual([]);
    expect(allowed.putIndex).toBe(true);
  });

  it("refuses when a default lesson is missing or in another language", () => {
    const plan = planPublish({
      next: index("c1", { burmese: entry("1", "en-US") }),
      live: null,
      allowRemovals: false,
      defaultLessons: DEFAULTS,
    });
    expect(plan.refusals).toHaveLength(2);
    expect(plan.refusals[0]).toMatch(/^the studio opens on "burmese" for my narration: Burmese/);
    expect(plan.refusals[1]).toBe(
      'the studio opens on "english" for en narration, and it is missing',
    );
  });

  it("does not take an inherited member for a lesson", () => {
    const lessons = Object.create(null) as Record<string, PublishedScriptEntry>;
    Object.assign(lessons, base, { constructor: entry("6") });
    const plan = planPublish({
      next: index("c2", lessons),
      live: liveOf(index("c1", base)),
      allowRemovals: false,
      defaultLessons: DEFAULTS,
    });
    expect(plan.added).toEqual(["constructor"]);
    expect(plan.puts).toEqual([id("6")]);
  });
});

describe("liveIndexMovedProblem", () => {
  it("lets the index be put when the live index is still the one planned from", () => {
    expect(liveIndexMovedProblem(null, null)).toBeNull();
    expect(liveIndexMovedProblem({ text: "a" }, { text: "a" })).toBeNull();
  });

  it("refuses when another publish wrote the index meanwhile", () => {
    expect(liveIndexMovedProblem({ text: "a" }, { text: "b" })).toMatch(/run the publish again/);
    expect(liveIndexMovedProblem(null, { text: "b" })).toMatch(/changed during this publish/);
    expect(liveIndexMovedProblem({ text: "a" }, null)).toMatch(/changed during this publish/);
  });
});

describe("lessonScriptReaderFiles", () => {
  it("keeps only the schema and the Director, without their tests", () => {
    expect(
      lessonScriptReaderFiles([
        "src/studio/script/schema.ts",
        "src/studio/script/compile.ts",
        "src/studio/script/compile.test.ts",
        "src/studio/script/__fixtures__/go-swap.yaml",
        "src/studio/inPageDirector.ts",
        "src/studio/inPageDirector.test.ts",
        "src/studio/scripts/go-swap.yaml",
        "src/studio/scriptx.ts",
        "docs/lesson-script-authoring.md",
      ]),
    ).toEqual([
      "src/studio/script/schema.ts",
      "src/studio/script/compile.ts",
      "src/studio/inPageDirector.ts",
    ]);
  });
});
