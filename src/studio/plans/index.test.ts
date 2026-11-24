// @vitest-environment node
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";
import { lessonScriptPath, lessonScriptSlugs } from "../../../scripts/lessonScriptsDir";
import { resolveAnchorOffset } from "../async";
import { defaultRuntimeModeOf } from "../plan";
import { compileWithEstimatedNarration, estimateByTokens } from "../script/estimatedCompile";
import { RECORDING_BUFFER_MS } from "../script/schedule";
import type { LessonScript } from "../script/schema";
import { validateNarrationLanguage } from "../narrationLanguage";
import {
  DEFAULT_ENGLISH_STUDIO_PLAN_SLUG,
  DEFAULT_STUDIO_PLAN_SLUG,
  defaultStudioPlanSlugFor,
  missingLessonReason,
  parseLessonScriptYaml,
  studioLessonSourcesOf,
} from "./index";
import type { PublishedScriptTexts } from "./publishedScriptFetch";
import { parsePublishedScriptIndex, type PublishedScriptIndex } from "./publishedScripts";

interface LessonScriptFile {
  slug: string;
  yamlText: string;
  script: LessonScript;
}

function readLessonScript(slug: string): LessonScriptFile {
  const yamlText = readFileSync(lessonScriptPath(slug), "utf8");
  return { slug, yamlText, script: parseLessonScriptYaml(yamlText) };
}

let lessonScriptFiles: LessonScriptFile[] | undefined;

/**
 * Every script in the lessons folder, read and parsed once for all the
 * sweeps below: parsing all of them is seconds, and each sweep needs them all.
 */
function lessonScripts(): LessonScriptFile[] {
  lessonScriptFiles ??= lessonScriptSlugs().map(readLessonScript);
  return lessonScriptFiles;
}

/** One script, without reading the whole folder when no sweep has yet. */
function lessonScriptOf(slug: string): LessonScriptFile {
  return lessonScriptFiles?.find((candidate) => candidate.slug === slug) ?? readLessonScript(slug);
}

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);

function indexOf(lessons: Record<string, string>): PublishedScriptIndex {
  return parsePublishedScriptIndex({
    version: 1,
    source: "abc123",
    lessons: Object.fromEntries(
      Object.entries(lessons).map(([slug, id]) => [
        slug,
        { id, bytes: 1, title: `Published ${slug}`, locale: "en-US", runtimeMode: "live" },
      ]),
    ),
  });
}

/** Texts by id, as the site would serve them. */
function textsOf(byId: Record<string, string>): PublishedScriptTexts {
  return {
    textOf: async (id) => {
      const text = byId[id];
      if (text === undefined) throw new Error(`no text for ${id}`);
      return text;
    },
  };
}

const noRefetch = () => Promise.reject(new Error("the index is not read again here"));

describe("studio lesson sources", () => {
  // `?plan=` indexes the record straight from the URL; an inherited member
  // used to slip past the falsy guard and throw during render.
  it("lists published and imported lessons in a record without a prototype", () => {
    const sources = studioLessonSourcesOf(
      indexOf({ "go-error-values": ID_A }),
      { mine: "not: [valid" },
      textsOf({}),
      noRefetch,
    );
    expect(Object.keys(sources).sort()).toEqual(["go-error-values", "mine"]);
    for (const slug of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(sources[slug]).toBeUndefined();
    }
    expect(studioLessonSourcesOf(undefined, {}, textsOf({}), noRefetch)).toEqual({});
  });

  it("gives a published lesson the index's facts and loads its script by id", async () => {
    const { yamlText, script } = lessonScriptOf(DEFAULT_ENGLISH_STUDIO_PLAN_SLUG);
    const source = studioLessonSourcesOf(
      indexOf({ [DEFAULT_ENGLISH_STUDIO_PLAN_SLUG]: ID_A }),
      {},
      textsOf({ [ID_A]: yamlText }),
      noRefetch,
    )[DEFAULT_ENGLISH_STUDIO_PLAN_SLUG];
    expect(source).toMatchObject({
      title: `Published ${DEFAULT_ENGLISH_STUDIO_PLAN_SLUG}`,
      locale: "en-US",
      runtimeMode: "live",
      imported: false,
      id: ID_A,
      problem: null,
    });
    const loaded = await source.load();
    expect(loaded.id).toBe(ID_A);
    expect(loaded.script.lesson.title).toBe(script.lesson.title);
  });

  it("says a published script this studio cannot parse needs another studio", async () => {
    const source = studioLessonSourcesOf(
      indexOf({ lesson: ID_A }),
      {},
      textsOf({ [ID_A]: "lesson:\n  slug: lesson\n  legacyField: 1\n" }),
      noRefetch,
    ).lesson;
    await expect(source.load()).rejects.toThrow(
      /published for a newer or older studio than this one: reload the page, or deploy the studio it needs\. Invalid lesson script:/,
    );
  });

  it("shadows a published lesson with an imported one of the same slug", async () => {
    const { yamlText, script } = lessonScriptOf(DEFAULT_STUDIO_PLAN_SLUG);
    const importedYaml = YAML.stringify({
      ...script,
      lesson: { ...script.lesson, title: "Imported edit" },
    });
    const sources = studioLessonSourcesOf(
      indexOf({ [DEFAULT_STUDIO_PLAN_SLUG]: ID_B }),
      { [DEFAULT_STUDIO_PLAN_SLUG]: importedYaml },
      textsOf({ [ID_B]: yamlText }),
      noRefetch,
    );
    const source = sources[DEFAULT_STUDIO_PLAN_SLUG];
    expect(source).toMatchObject({
      title: "Imported edit",
      locale: script.lesson.locale,
      runtimeMode: defaultRuntimeModeOf(script.runtime),
      imported: true,
      id: null,
      problem: null,
    });
    const loaded = await source.load();
    expect(loaded.id).toBeNull();
    expect(loaded.script.lesson.title).toBe("Imported edit");
  });

  it("keeps an imported script that does not parse, and says why", async () => {
    const source = studioLessonSourcesOf(
      undefined,
      { mine: "lesson: {}\n" },
      textsOf({}),
      noRefetch,
    ).mine;
    expect(source).toMatchObject({
      title: "mine",
      locale: null,
      runtimeMode: null,
      imported: true,
    });
    expect(source.problem).toMatch(/^Invalid lesson script:/);
    await expect(source.load()).rejects.toThrow(/^Invalid lesson script:/);
  });

  it("says why a lesson is not listed", () => {
    const sources = {};
    expect(missingLessonReason({ status: "loading", error: null, sources }, "x")).toMatch(
      /Reading the list/,
    );
    expect(missingLessonReason({ status: "error", error: "HTTP 500.", sources }, "x")).toMatch(
      /published lessons could not be read, so "x" is not available: HTTP 500\./,
    );
    expect(missingLessonReason({ status: "ready", error: null, sources }, "x")).toBe(
      'Unknown lesson "x": it is not published on this site and not imported.',
    );
  });
});

// Three of these tests parse (and one compiles) every script in the lessons
// folder, hundreds of them and growing with each course. Each sweep takes
// seconds on its own and more when the whole studio suite runs in parallel,
// so the budget here is sized for the folder rather than for one lesson.
describe("lesson scripts in the folder", { timeout: 60_000 }, () => {
  // Start render refuses a script the selected voice cannot speak, so a default
  // in the wrong language opens Studio on a disabled button. Publishing refuses
  // to go ahead without both.
  it("has the lesson each narration language opens on, in that language", () => {
    expect(defaultStudioPlanSlugFor("my")).toBe(DEFAULT_STUDIO_PLAN_SLUG);
    expect(defaultStudioPlanSlugFor("en")).toBe(DEFAULT_ENGLISH_STUDIO_PLAN_SLUG);
    for (const language of ["en", "my"] as const) {
      const { script } = lessonScriptOf(defaultStudioPlanSlugFor(language));
      expect(validateNarrationLanguage(script.lesson.locale, language)).toBeNull();
    }
  });

  it("never counts critic sidecars as lessons", () => {
    expect(lessonScripts().length).toBeGreaterThan(0);
    for (const { slug } of lessonScripts()) {
      expect(slug).not.toContain(".critique");
    }
  });

  it("parses every script, each named by its file", () => {
    for (const { slug, script: lesson } of lessonScripts()) {
      // The studio finds a lesson by its file name; the parsed content must agree.
      expect(lesson.lesson.slug).toBe(slug);
      expect(lesson.lesson.title.length).toBeGreaterThan(0);
      expect(["live", "fixture"]).toContain(defaultRuntimeModeOf(lesson.runtime));
    }
  });

  it("keeps every authored editor target valid after the preceding insertions", () => {
    // Collect every unresolved anchor so one bad script reports all of its
    // misses at once instead of failing on the first.
    const missingAnchors: string[] = [];

    for (const { slug, script } of lessonScripts()) {
      const files = { ...script.lesson.workspace.files };

      for (const scene of script.scenes) {
        for (const action of scene.actions) {
          if (action.type === "editor.type") {
            const content = files[action.target.file];
            const offset = resolveAnchorOffset(content, action.target);
            if (offset === null) {
              missingAnchors.push(`${slug}/${action.id} has a missing typing anchor`);
              continue;
            }
            files[action.target.file] =
              content.slice(0, offset) + action.text + content.slice(offset);
          }
          if (action.type === "editor.select") {
            const content = files[action.target.file];
            const offset = resolveAnchorOffset(content, {
              after: action.target.text,
              occurrence: action.target.occurrence,
            });
            if (offset === null) {
              missingAnchors.push(`${slug}/${action.id} has a missing selection target`);
            }
          }
        }
      }
    }

    expect(missingAnchors).toEqual([]);
  });

  it("compiles every script with recording handles and authored selection gestures", () => {
    // Every Rust lesson must author at least one mouse gesture; Go predates
    // the requirement, so the check is per-slug rather than global.
    const rustScriptsWithoutGestures: string[] = [];

    for (const { slug, script } of lessonScripts()) {
      const { schedule, plan } = compileWithEstimatedNarration(script, estimateByTokens);

      const lastDialog = schedule.timeline.at(-1)!;
      expect(schedule.timeline[0].startMs, `${slug} opening handle`).toBe(RECORDING_BUFFER_MS);
      expect(
        schedule.totalDurationMs - lastDialog.startMs - lastDialog.durationMs,
        `${slug} closing handle`,
      ).toBeGreaterThanOrEqual(RECORDING_BUFFER_MS);

      // A lesson that opens with the file explorer shut has no file rows to
      // point at, and the render fails closed on a target it cannot resolve —
      // so the compiler must not emit the cursor glide it normally puts in
      // front of an openFile.
      const cursorsAtHiddenFileRows = script.lesson.workspace.sidebarStartsCollapsed
        ? plan.actions.filter(
            (action) => action.type === "cursor.moveTo" && action.target.kind === "file",
          )
        : [];
      expect(cursorsAtHiddenFileRows, `${slug} cursor moves to a hidden file row`).toEqual([]);

      // Every pointer move is a hand operating a real control: it ends in a
      // click, and never on a dock container (its middle is empty console).
      for (const action of plan.actions) {
        if (action.type !== "cursor.moveTo") continue;
        expect(action.press, `${slug}/${action.id} pointer move ends in a click`).toBe(true);
        expect(
          action.target.kind === "target-id" && action.target.id.endsWith("-runner-dock"),
          `${slug}/${action.id} aims at a dock container`,
        ).toBe(false);
      }

      const authoredSelects = script.scenes
        .flatMap((scene) => scene.actions)
        .filter((action) => action.type === "editor.select");
      const compiledSelects = plan.actions.filter((action) => action.type === "editor.select");
      expect(compiledSelects, `${slug} compiled selections`).toHaveLength(authoredSelects.length);

      let editBusyUntilMs = 0;
      for (const action of plan.actions) {
        if (action.type !== "editor.type" && action.type !== "editor.select") continue;
        expect(
          action.at,
          `${slug}/${action.id} overlaps the previous editor gesture`,
        ).toBeGreaterThanOrEqual(editBusyUntilMs);
        const busyMs =
          action.type === "editor.type"
            ? action.chunks.reduce((total, chunk) => total + chunk.delayMs, 0)
            : action.durationMs;
        editBusyUntilMs = action.at + busyMs;
      }

      if (slug.startsWith("rust-") && authoredSelects.length === 0) {
        rustScriptsWithoutGestures.push(slug);
      }
    }

    expect(rustScriptsWithoutGestures).toEqual([]);
  });
});
