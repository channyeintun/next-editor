import { describe, expect, it } from "vite-plus/test";
import { parseRuntimeModeParam, parseStudioPlan, type StudioPlan } from "./plan";

/** Even per-word interpolation inside a cue, like the compiler emits. */
function toCue(start: number, end: number, text: string) {
  const tokens = text.split(" ").filter((token) => token.length > 0);
  const step = (end - start) / tokens.length;
  return {
    start,
    end,
    text,
    words: tokens.map((token, index) => ({
      start: Math.round(start + index * step),
      end: Math.round(start + (index + 1) * step),
      text: token,
    })),
  };
}

/**
 * Minimal valid plan the schema-gate tests mutate. Self-contained — pocket-tts
 * narration is synthesized at render time, so the fixture only pins timings.
 */
function createTestPlan(): StudioPlan {
  return parseStudioPlan({
    schemaVersion: 1,
    lesson: { slug: "test-plan", title: "Test plan", locale: "en-US" },
    seed: 7,
    workspace: {
      lessonType: "rust",
      name: "Rust Lesson",
      entryFilePath: "main.rs",
      files: { "main.rs": 'fn main() {\n    println!("ok");\n}\n' },
    },
    narration: {
      audioPath: "studio-tts://test",
      mimeType: "audio/wav",
      expectedDurationMs: 20_000,
      captions: {
        id: "studio-narration",
        language: "en",
        label: "en-US",
        cues: [
          toCue(0, 9_000, "Let's add a helper function above main."),
          toCue(9_000, 19_500, "Run it, and the program prints ok."),
        ],
      },
    },
    runtime: {
      kind: "rust-playground",
      defaultMode: "fixture",
      fixture: {
        latencyMs: 100,
        transientErrorKinds: [],
        result: { status: "success", stdout: "ok\n", stderr: "" },
      },
    },
    actions: [
      { id: "open-main", at: 500, type: "workspace.openFile", path: "main.rs" },
      {
        id: "cursor-type",
        at: 1_000,
        type: "cursor.moveTo",
        target: { kind: "editor" },
        durationMs: 600,
      },
      {
        id: "type-helper",
        at: 2_000,
        type: "editor.type",
        path: "main.rs",
        anchor: { after: "", occurrence: 1 },
        chunks: [
          { delayMs: 120, text: "fn helper() {}" },
          { delayMs: 150, text: "\n" },
        ],
      },
      { id: "run", at: 9_000, type: "runtime.run", timeoutMs: 15_000 },
      { id: "expect-output", at: 15_000, type: "expect.output", contains: "ok" },
      { id: "expect-file", at: 15_500, type: "expect.file", path: "main.rs", contains: "helper" },
    ],
  });
}

function clonePlan(plan: StudioPlan): StudioPlan {
  return structuredClone(plan);
}

describe("studio plan schema", () => {
  it("accepts the reference test plan", () => {
    const plan = createTestPlan();
    expect(plan.lesson.slug).toBe("test-plan");
    expect(plan.actions.length).toBeGreaterThan(5);
  });

  it("rejects duplicate action ids", () => {
    const plan = clonePlan(createTestPlan());
    plan.actions[1].id = plan.actions[0].id;
    expect(() => parseStudioPlan(plan)).toThrow(/Duplicate action id/);
  });

  it("rejects actions scheduled out of order", () => {
    const plan = clonePlan(createTestPlan());
    plan.actions[1].at = plan.actions[0].at - 100;
    expect(() => parseStudioPlan(plan)).toThrow(/before its predecessor/);
  });

  it("rejects typing that overlaps the next action", () => {
    const plan = clonePlan(createTestPlan());
    const typing = plan.actions.find((action) => action.type === "editor.type");
    if (typing?.type !== "editor.type") throw new Error("fixture has no typing action");
    typing.chunks[0] = { ...typing.chunks[0], delayMs: 60_000 };
    expect(() => parseStudioPlan(plan)).toThrow(/overlaps/);
  });

  it("accepts an editor.select drag action", () => {
    const plan = clonePlan(createTestPlan());
    plan.actions.splice(3, 0, {
      id: "highlight",
      at: 5_000,
      timeoutMs: 1_000,
      type: "editor.select",
      path: "main.rs",
      selection: { text: "println!", occurrence: 1 },
      durationMs: 500,
    });
    const parsed = parseStudioPlan(plan);
    expect(parsed.actions.find((action) => action.id === "highlight")?.type).toBe("editor.select");
  });

  it("rejects a select drag that overlaps the next action", () => {
    const plan = clonePlan(createTestPlan());
    plan.actions.splice(3, 0, {
      id: "highlight",
      at: 5_000,
      timeoutMs: 1_000,
      type: "editor.select",
      path: "main.rs",
      selection: { text: "println!", occurrence: 1 },
      durationMs: 60_000,
    });
    expect(() => parseStudioPlan(plan)).toThrow(/Selection action "highlight" .* overlaps/);
  });

  it("rejects a select in a file outside the pinned workspace", () => {
    const plan = clonePlan(createTestPlan());
    plan.actions.splice(3, 0, {
      id: "highlight",
      at: 5_000,
      timeoutMs: 1_000,
      type: "editor.select",
      path: "missing.rs",
      selection: { text: "println!", occurrence: 1 },
      durationMs: 500,
    });
    expect(() => parseStudioPlan(plan)).toThrow(/not in the pinned workspace/);
  });

  it("rejects references to files outside the pinned workspace", () => {
    const plan = clonePlan(createTestPlan());
    const open = plan.actions.find((action) => action.type === "workspace.openFile");
    if (open?.type !== "workspace.openFile") throw new Error("fixture has no openFile action");
    open.path = "missing.rs";
    expect(() => parseStudioPlan(plan)).toThrow(/not in the pinned workspace/);
  });

  it("rejects actions scheduled after the narration ends", () => {
    const plan = clonePlan(createTestPlan());
    const last = plan.actions.at(-1)!;
    last.at = plan.narration.expectedDurationMs + 1;
    expect(() => parseStudioPlan(plan)).toThrow(/after the narration ends/);
  });

  it("rejects overlapping caption cues", () => {
    const plan = clonePlan(createTestPlan());
    plan.narration.captions.cues[1].start = plan.narration.captions.cues[0].end - 50;
    // Word timings inside the shifted cue no longer matter for this test; the
    // cue-overlap issue alone must reject the plan.
    expect(() => parseStudioPlan(plan)).toThrow(/overlaps cue/);
  });
});

describe("parseRuntimeModeParam (STUDIO-05)", () => {
  it("accepts both documented values", () => {
    expect(parseRuntimeModeParam("live")).toEqual({ mode: "live", invalid: false, raw: "live" });
    expect(parseRuntimeModeParam("fixture")).toEqual({
      mode: "fixture",
      invalid: false,
      raw: "fixture",
    });
  });

  it("treats a missing or empty param as no request (use the plan default)", () => {
    expect(parseRuntimeModeParam(null)).toEqual({ mode: null, invalid: false, raw: null });
    expect(parseRuntimeModeParam("")).toEqual({ mode: null, invalid: false, raw: "" });
  });

  it("flags an unrecognized value as invalid instead of silently defaulting", () => {
    // The bug: `fixture` (and everything but `live`) used to collapse to null and
    // silently fall back to the plan default — a live-default plan would then
    // contact the real service even though fixture was requested.
    expect(parseRuntimeModeParam("staging")).toEqual({
      mode: null,
      invalid: true,
      raw: "staging",
    });
    expect(parseRuntimeModeParam("Live").invalid).toBe(true);
    expect(parseRuntimeModeParam("FIXTURE").invalid).toBe(true);
  });
});
