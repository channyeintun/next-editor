import { describe, expect, it } from "vite-plus/test";
import {
  isTimelineIssue,
  parseStudioPlan,
  StudioPlanError,
  planActionBusyMs,
  studioRuntimeSchema,
  studioWhiteboardAssetSchema,
  type StudioPlan,
  type StudioPlaygroundRuntimeKind,
} from "./plan";

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

  it("rejects a whiteboard drawing that overlaps the next action", () => {
    const plan = clonePlan(createTestPlan());
    plan.whiteboardAssets.push({
      id: "diagram",
      kind: "rectangle",
      x: 100,
      y: 100,
      width: 300,
      height: 180,
      stroke: "underline",
      strokeColor: "#ffffff",
      backgroundColor: "transparent",
      fontSize: 20,
    });
    plan.actions.splice(3, 0, {
      id: "draw-diagram",
      at: 5_000,
      timeoutMs: 10_000,
      type: "whiteboard.apply",
      upsertIds: ["diagram"],
      clear: false,
      drawMs: 6_000,
    });
    expect(() => parseStudioPlan(plan)).toThrow(
      /Whiteboard drawing action "draw-diagram" .* overlaps/,
    );
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

  // The compiler gives its marks/offsets advice from this flag, not by matching
  // the messages, so only the two timeline issues may carry it.
  it("flags its timeline issues, and only those, on the thrown error", () => {
    const issuesOf = (plan: StudioPlan) => {
      try {
        parseStudioPlan(plan);
      } catch (error) {
        if (error instanceof StudioPlanError) return error.issues;
        throw error;
      }
      throw new Error("plan parsed");
    };

    const late = clonePlan(createTestPlan());
    late.actions.at(-1)!.at = late.narration.expectedDurationMs + 1;
    const lateIssue = issuesOf(late).find((issue) =>
      /after the narration ends/.test(issue.message),
    );
    expect(lateIssue && isTimelineIssue(lateIssue)).toBe(true);

    const overlapping = clonePlan(createTestPlan());
    const typing = overlapping.actions.find((action) => action.type === "editor.type");
    if (typing?.type !== "editor.type") throw new Error("fixture has no typing action");
    typing.chunks[0] = { ...typing.chunks[0], delayMs: 60_000 };
    const overlap = issuesOf(overlapping).find((issue) => /overlaps/.test(issue.message));
    expect(overlap && isTimelineIssue(overlap)).toBe(true);

    const duplicate = clonePlan(createTestPlan());
    duplicate.actions[1].id = duplicate.actions[0].id;
    expect(issuesOf(duplicate).some(isTimelineIssue)).toBe(false);
  });

  // `actions: []` is a *continuable* failure, so Zod still runs the plan's
  // superRefine with an empty array. Reading the last action unguarded there threw
  // a TypeError out of safeParse instead of reporting the schema's own message.
  it("reports an empty action list rather than throwing", () => {
    const plan = createTestPlan() as unknown as { actions: unknown[] };
    plan.actions = [];
    expect(() => parseStudioPlan(plan)).toThrow(/expected array to have >=1 items/);
  });

  it("rejects overlapping caption cues", () => {
    const plan = clonePlan(createTestPlan());
    plan.narration.captions.cues[1].start = plan.narration.captions.cues[0].end - 50;
    // Word timings inside the shifted cue no longer matter for this test; the
    // cue-overlap issue alone must reject the plan.
    expect(() => parseStudioPlan(plan)).toThrow(/overlaps cue/);
  });
});

describe("planActionBusyMs", () => {
  it("counts each timed action's busy time and nothing for the rest", () => {
    const typing = createTestPlan().actions.find((action) => action.id === "type-helper")!;
    expect(planActionBusyMs(typing)).toBe(270);
    expect(planActionBusyMs({ type: "editor.select", durationMs: 640 })).toBe(640);
    expect(planActionBusyMs({ type: "console.point", durationMs: 900 })).toBe(900);
    // A drawn apply spends one 50ms frame per drawn step, at least one per asset.
    expect(planActionBusyMs({ type: "whiteboard.apply", upsertIds: ["a"], drawMs: 800 })).toBe(800);
    expect(
      planActionBusyMs({ type: "whiteboard.apply", upsertIds: ["a", "b", "c"], drawMs: 100 }),
    ).toBe(150);
    expect(planActionBusyMs({ type: "whiteboard.apply", upsertIds: ["a"], drawMs: 0 })).toBe(0);
    // A pointer move's duration is its own travel, not busy time it adds.
    const cursor = createTestPlan().actions.find((action) => action.id === "cursor-type")!;
    expect(planActionBusyMs(cursor)).toBe(0);
    expect(planActionBusyMs({ type: "runtime.run" })).toBe(0);
  });
});

describe("studio whiteboard asset defaults", () => {
  it("defaults to ink and a label size that read on the dark-theme board", () => {
    // Excalidraw's dark theme inverts colours, so #1e1e1e is what paints white.
    const asset = studioWhiteboardAssetSchema.parse({
      id: "label",
      kind: "text",
      x: 300,
      y: 200,
      width: 400,
      height: 40,
      text: "hello",
    });
    expect(asset.strokeColor).toBe("#1e1e1e");
    expect(asset.fontSize).toBe(28);
  });
});

/** A minimal valid pinned result per Playground kind. */
const PLAYGROUND_RESULTS: Record<StudioPlaygroundRuntimeKind, unknown> = {
  "go-playground": { status: "success", output: "", exitCode: 0 },
  "kotlin-playground": { status: "success", output: "" },
  "rust-playground": { status: "success", stdout: "", stderr: "" },
  "zig-playground": { status: "success", output: "" },
  "haskell-playground": { status: "success", stdout: "", stderr: "" },
  "kite-playground": { status: "success", stdout: "", stderr: "" },
  "asm-playground": { status: "success", stdout: "", stderr: "" },
};

describe("studio Playground runtime schemas", () => {
  it("give every kind the same defaults and keep what was authored", () => {
    for (const [kind, result] of Object.entries(PLAYGROUND_RESULTS)) {
      const fixture = { latencyMs: 5, result };
      expect(studioRuntimeSchema.parse({ kind, defaultMode: "fixture", fixture })).toEqual({
        kind,
        dockStartsCollapsed: false,
        defaultMode: "fixture",
        fixture: { latencyMs: 5, transientErrorKinds: [], result },
      });
      expect(
        studioRuntimeSchema.parse({
          kind,
          dockStartsCollapsed: true,
          defaultMode: "live",
          fixture,
        }),
      ).toMatchObject({ kind, dockStartsCollapsed: true, defaultMode: "live" });
    }
  });

  it("admit only the transient failures each runner can have", () => {
    const parses = (kind: StudioPlaygroundRuntimeKind, transientErrorKinds: string[]) =>
      studioRuntimeSchema.safeParse({
        kind,
        defaultMode: "fixture",
        fixture: { latencyMs: 5, transientErrorKinds, result: PLAYGROUND_RESULTS[kind] },
      }).success;

    for (const kind of [
      "go-playground",
      "kotlin-playground",
      "rust-playground",
      "zig-playground",
      "haskell-playground",
    ] as const) {
      expect(parses(kind, ["rate-limited", "timeout", "unavailable"])).toBe(true);
    }
    // Kite and asm run in the page: there is no service to rate-limit or time out.
    for (const kind of ["kite-playground", "asm-playground"] as const) {
      expect(parses(kind, ["unavailable"])).toBe(true);
      expect(parses(kind, ["timeout"])).toBe(false);
      expect(parses(kind, ["rate-limited"])).toBe(false);
    }
  });
});
