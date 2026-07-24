import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";
import { compileLessonScript, typingDurationOf, typingSeedsOf } from "./compile";
import { splitIntoDialogs } from "./dialogs";
import { LEXICON_V1 } from "./lexicon";
import { extractNarration, type ExtractedNarration } from "./markers";
import { RECORDING_BUFFER_MS, ScheduleError, scheduleDialogs } from "./schedule";
import { parseLessonScript, type LessonScript } from "./schema";

function loadPilot(name: string): LessonScript {
  return parseLessonScript(
    YAML.parse(readFileSync(resolve(__dirname, `./__fixtures__/${name}.yaml`), "utf8")),
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
  it("keeps two-second quiet handles before and after the authored performance", () => {
    const { schedule } = scheduleFor(loadPilot("go-swap"));
    const firstDialog = schedule.timeline[0];
    const lastDialog = schedule.timeline.at(-1)!;

    expect(RECORDING_BUFFER_MS).toBe(2_000);
    expect(firstDialog.startMs).toBe(RECORDING_BUFFER_MS);
    expect(schedule.totalDurationMs).toBeGreaterThanOrEqual(
      lastDialog.startMs + lastDialog.durationMs + RECORDING_BUFFER_MS,
    );
  });

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

  it("reserves cumulative busy time for a modeled afterAction chain", () => {
    const script = loadPilot("go-cube");
    const scene = script.scenes[0];
    const firstIndex = scene.actions.findIndex((action) => action.id === "type-cube");
    const first = scene.actions[firstIndex];
    if (first?.type !== "editor.type") throw new Error("pilot changed");
    const second = {
      ...first,
      id: "type-more",
      at: { afterAction: first.id } as const,
      text: "\n// a second modeled edit\n",
    };
    scene.actions.splice(firstIndex + 1, 0, second);

    const { extracted, dialogs, schedule } = scheduleFor(script);
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

    const firstPlan = plan.actions.find((action) => action.id === first.id);
    const secondPlan = plan.actions.find((action) => action.id === second.id);
    if (firstPlan?.type !== "editor.type" || secondPlan?.type !== "editor.type") {
      throw new Error("compiled typing actions missing");
    }
    const firstBusyMs = firstPlan.chunks.reduce((total, chunk) => total + chunk.delayMs, 0);
    const secondBusyMs = secondPlan.chunks.reduce((total, chunk) => total + chunk.delayMs, 0);
    expect(secondPlan.at).toBe(firstPlan.at + firstBusyMs);

    if (!("mark" in first.at)) throw new Error("pilot changed");
    const marker = extracted.markers.get(first.at.mark)!;
    const dialogIndex = dialogs.findIndex(
      (dialog) => dialog.firstTokenIndex === marker.beforeTokenIndex,
    );
    const nextDialog = schedule.timeline[dialogIndex + 1];
    expect(nextDialog.startMs).toBeGreaterThanOrEqual(secondPlan.at + secondBusyMs);
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

  // go-swap anchors `type-call` at `mark - 300ms`, and a mark sits only
  // DIALOG_LEAD_MS into its dialog. Clearing just BUSY_PAD_MS therefore started
  // that typing 20ms before the previous edit had finished, and the whole
  // narration was synthesized before the plan gate rejected the overlap.
  it("clears an action that is anchored before its own mark", () => {
    const script = loadPilot("go-swap");
    const { extracted, schedule } = scheduleFor(script);

    expect(() =>
      compileLessonScript({
        script,
        extracted,
        alignment: schedule.alignment,
        narration: {
          audioPath: "studio-tts://test",
          mimeType: "audio/wav",
          durationMs: schedule.totalDurationMs,
        },
      }),
    ).not.toThrow();
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
