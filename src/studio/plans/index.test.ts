import { describe, expect, it } from "vite-plus/test";
import { resolveAnchorOffset } from "../async";
import type { StudioSlide } from "../plan";
import { compileLessonScript } from "../script/compile";
import { splitIntoDialogs } from "../script/dialogs";
import { LEXICON_V1 } from "../script/lexicon";
import { extractNarration } from "../script/markers";
import { RECORDING_BUFFER_MS, scheduleDialogs } from "../script/schedule";
import { DEFAULT_STUDIO_PLAN_SLUG, STUDIO_SOURCES } from "./index";

describe("studio lesson registry", () => {
  it("registers exactly the checked-in scripts (Rust course + Go)", () => {
    // Scripts auto-register by filename without any manual registry edit.
    // Grows as the course does; keep this list in sync with the YAML files
    // under src/studio/scripts/.
    expect(Object.keys(STUDIO_SOURCES).sort()).toEqual([
      "go-error-values",
      "rust-borrow",
      "rust-control-flow",
      "rust-data-types",
      "rust-enums",
      "rust-error-handling",
      "rust-functions",
      "rust-generics",
      "rust-hashmaps",
      "rust-iterators",
      "rust-lifetimes",
      "rust-match",
      "rust-ownership",
      "rust-slices",
      "rust-strings",
      "rust-structs",
      "rust-traits",
      "rust-variables",
      "rust-vectors",
    ]);
    expect(STUDIO_SOURCES[DEFAULT_STUDIO_PLAN_SLUG]?.kind).toBe("script");
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
      // (Plan-kind fixtures own their slug independently of the registry key.)
      expect(source.kind === "script" ? lesson.lesson.slug : slug).toBe(slug);
      expect(lesson.lesson.title.length).toBeGreaterThan(0);
      expect(["live", "fixture"]).toContain(
        lesson.runtime.kind === "none" ? "fixture" : lesson.runtime.defaultMode,
      );
    }
  });

  it("keeps every authored editor target valid after the preceding insertions", () => {
    // Collect every unresolved anchor so one bad script reports all of its
    // misses at once instead of failing on the first.
    const missingAnchors: string[] = [];

    for (const [slug, source] of Object.entries(STUDIO_SOURCES)) {
      if (source.kind !== "script") continue;
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
      if (source.kind !== "script") continue;
      const script = source.load();
      const extracted = extractNarration(
        script.scenes.map((scene) => ({ sceneId: scene.id, narration: scene.narration })),
      );
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
