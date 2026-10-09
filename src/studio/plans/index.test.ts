import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";
import { resolveAnchorOffset } from "../async";
import { defaultRuntimeModeOf, type StudioSlide } from "../plan";
import { compileLessonScript } from "../script/compile";
import { splitIntoDialogs } from "../script/dialogs";
import { LEXICON_V1 } from "../script/lexicon";
import { extractScriptNarration } from "../script/markers";
import { RECORDING_BUFFER_MS, scheduleDialogs } from "../script/schedule";
import { DEFAULT_STUDIO_PLAN_SLUG, STUDIO_SOURCES, mergeStudioSources } from "./index";

describe("studio lesson registry", () => {
  it("registers exactly the checked-in scripts", () => {
    // Scripts auto-register by filename without any manual registry edit, so
    // the expected list is read from the same directory — a new lesson needs
    // no test edit, while a dropped or extra registration still fails.
    const checkedIn = readdirSync(resolve(__dirname, "../scripts"))
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => name.replace(/\.ya?ml$/, ""))
      .sort();
    expect(checkedIn.length).toBeGreaterThan(0);
    expect(Object.keys(STUDIO_SOURCES).sort()).toEqual(checkedIn);
    expect(STUDIO_SOURCES[DEFAULT_STUDIO_PLAN_SLUG]).toBeDefined();
  });

  // `?plan=` indexes the merged record straight from the URL; an inherited
  // member used to slip past the falsy guard and throw from `.load()`.
  it("merges imported scripts over the checked-in ones without a prototype", () => {
    const merged = mergeStudioSources({});
    expect(Object.keys(merged).sort()).toEqual(Object.keys(STUDIO_SOURCES).sort());
    for (const slug of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(merged[slug]).toBeUndefined();
      expect(STUDIO_SOURCES[slug]).toBeUndefined();
    }

    const checkedIn = STUDIO_SOURCES[DEFAULT_STUDIO_PLAN_SLUG].load();
    const importedYaml = YAML.stringify({
      ...checkedIn,
      lesson: { ...checkedIn.lesson, title: "Imported edit" },
    });
    const shadowed = mergeStudioSources({ [DEFAULT_STUDIO_PLAN_SLUG]: importedYaml });
    expect(Object.keys(shadowed)).toEqual(Object.keys(STUDIO_SOURCES));
    expect(shadowed[DEFAULT_STUDIO_PLAN_SLUG].load().lesson.title).toBe("Imported edit");
  });

  it("never registers critic sidecars as lessons", () => {
    for (const slug of Object.keys(STUDIO_SOURCES)) {
      expect(slug).not.toContain(".critique");
    }
  });

  it("loads every registered source through its parser", () => {
    for (const [slug, source] of Object.entries(STUDIO_SOURCES)) {
      const lesson = source.load();
      // Script slugs come from filenames; the parsed content must agree.
      expect(lesson.lesson.slug).toBe(slug);
      expect(lesson.lesson.title.length).toBeGreaterThan(0);
      expect(["live", "fixture"]).toContain(defaultRuntimeModeOf(lesson.runtime));
    }
  });

  it("keeps every authored editor target valid after the preceding insertions", () => {
    // Collect every unresolved anchor so one bad script reports all of its
    // misses at once instead of failing on the first.
    const missingAnchors: string[] = [];

    for (const [slug, source] of Object.entries(STUDIO_SOURCES)) {
      const script = source.load();
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

    for (const [slug, source] of Object.entries(STUDIO_SOURCES)) {
      const script = source.load();
      const extracted = extractScriptNarration(script);
      const dialogs = splitIntoDialogs(extracted);
      const schedule = scheduleDialogs({
        script,
        extracted,
        dialogs,
        durationsMs: dialogs.map((dialog) => 400 + dialog.tokens.length * 320),
        lexicon: LEXICON_V1,
      });
      const resolvedSlides: StudioSlide[] = script.lesson.slides.map((slide) =>
        slide.contentType === "google"
          ? {
              id: slide.id,
              contentType: "google-svg",
              content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
              name: slide.name,
              sourceUrl: slide.deckUrl,
            }
          : slide,
      );
      const { plan } = compileLessonScript({
        script,
        extracted,
        alignment: schedule.alignment,
        narration: {
          audioPath: "studio-tts://registry-test",
          mimeType: "audio/wav",
          durationMs: schedule.totalDurationMs,
        },
        resolvedSlides,
      });

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
