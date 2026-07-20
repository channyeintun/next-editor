import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";
import { compileLessonScript, typingDurationOf, typingSeedsOf } from "./compile";
import { splitIntoDialogs } from "./dialogs";
import { LEXICON_V1 } from "./lexicon";
import { extractNarration, type ExtractedNarration } from "./markers";
import { ScheduleError, scheduleDialogs } from "./schedule";
import { parseLessonScript, type LessonScript } from "./schema";

function loadPilot(name: string): LessonScript {
  return parseLessonScript(
    YAML.parse(readFileSync(resolve(__dirname, `../scripts/${name}.yaml`), "utf8")),
  );
}

function extractedOf(script: LessonScript): ExtractedNarration {
  return extractNarration(
    script.scenes.map((scene) => ({ sceneId: scene.id, narration: scene.narration })),
  );
}

/** Deterministic fake per-dialog durations: proportional to token count. */
function fakeDurations(dialogCount: number, extracted: ExtractedNarration): number[] {
  const dialogs = splitIntoDialogs(extracted);
  expect(dialogs).toHaveLength(dialogCount);
  return dialogs.map((dialog) => 400 + dialog.tokens.length * 320);
}

function scheduleFor(script: LessonScript) {
  const extracted = extractedOf(script);
  const dialogs = splitIntoDialogs(extracted);
  return {
    extracted,
    dialogs,
    schedule: scheduleDialogs({
      script,
      extracted,
      dialogs,
      durationsMs: fakeDurations(dialogs.length, extracted),
      lexicon: LEXICON_V1,
    }),
  };
}

describe("scheduleDialogs", () => {
  it("keeps dialogs ordered, non-overlapping, and inside the total duration", () => {
    const { schedule } = scheduleFor(loadPilot("go-cube-tour"));
    for (let i = 0; i < schedule.timeline.length; i++) {
      const entry = schedule.timeline[i];
      expect(entry.startMs).toBeGreaterThanOrEqual(0);
      const previous = schedule.timeline[i - 1];
      expect(entry.startMs).toBeGreaterThanOrEqual(
        i === 0 ? 0 : previous.startMs + previous.durationMs,
      );
      expect(entry.startMs + entry.durationMs).toBeLessThanOrEqual(schedule.totalDurationMs);
    }
  });

  it("pushes narration until an anchored typing action finishes", () => {
    const script = loadPilot("go-cube");
    const { extracted, dialogs, schedule } = scheduleFor(script);

    // type-cube anchors to the dialog that starts at mark "type-cube"; the
    // following dialog may not begin until its typing is done.
    const typeCube = script.scenes[0].actions.find((action) => action.id === "type-cube")!;
    if (!("mark" in typeCube.at)) throw new Error("pilot changed");
    const marker = extracted.markers.get(typeCube.at.mark)!;
    const dialogIndex = dialogs.findIndex(
      (dialog) => dialog.firstTokenIndex === marker.beforeTokenIndex,
    );
    expect(dialogIndex).toBeGreaterThanOrEqual(0);

    const markTime = schedule.alignment.tokens[marker.beforeTokenIndex].startMs;
    const typingMs = typingDurationOf(typeCube, typingSeedsOf(script).get("type-cube")!);
    const typingEnds = Math.max(0, markTime + typeCube.at.offsetMs) + typingMs;
    const nextDialog = schedule.timeline[dialogIndex + 1];
    expect(nextDialog.startMs).toBeGreaterThanOrEqual(Math.floor(typingEnds));
  });

  it("produces an alignment the compiler accepts without overlap failures", () => {
    const script = loadPilot("go-cube-tour");
    const { extracted, schedule } = scheduleFor(script);
    const { plan } = compileLessonScript({
      script,
      extracted,
      alignment: schedule.alignment,
      narration: {
        audioPath: "studio-tts://test",
        mimeType: "audio/wav",
        durationMs: schedule.totalDurationMs,
      },
    });
    expect(plan.narration.expectedDurationMs).toBe(schedule.totalDurationMs);
    expect(plan.actions.at(-1)!.at).toBeLessThan(schedule.totalDurationMs);
  });

  it("is deterministic for identical inputs", () => {
    const first = scheduleFor(loadPilot("go-swap")).schedule;
    const second = scheduleFor(loadPilot("go-swap")).schedule;
    expect(second).toEqual(first);
  });

  it("warns when actions force long dead air", () => {
    const script = loadPilot("go-cube");
    const typeCube = script.scenes[0].actions.find((action) => action.id === "type-cube");
    if (typeCube?.type !== "editor.type") throw new Error("pilot changed");
    typeCube.text = typeCube.text.repeat(4); // several extra seconds of typing
    const { schedule } = scheduleFor(script);
    expect(schedule.warnings.some((warning) => warning.includes("silence inserted"))).toBe(true);
  });

  it("rejects mismatched duration counts and invalid durations", () => {
    const script = loadPilot("go-swap");
    const extracted = extractedOf(script);
    const dialogs = splitIntoDialogs(extracted);
    expect(() =>
      scheduleDialogs({ script, extracted, dialogs, durationsMs: [1_000], lexicon: LEXICON_V1 }),
    ).toThrow(ScheduleError);
    expect(() =>
      scheduleDialogs({
        script,
        extracted,
        dialogs,
        durationsMs: dialogs.map(() => Number.NaN),
        lexicon: LEXICON_V1,
      }),
    ).toThrow(/invalid duration/);
  });
});
