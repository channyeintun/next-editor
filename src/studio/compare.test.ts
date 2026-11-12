import { describe, expect, it } from "vite-plus/test";
import { compareRenderSemantics, type RenderSemantics } from "./compare";

function makeSemantics(overrides: Partial<RenderSemantics> = {}): RenderSemantics {
  return {
    planSha256: "planhash1",
    actionSequence: [
      { actionId: "open", actionType: "workspace.openFile", status: "ok" },
      { actionId: "run", actionType: "runtime.run", status: "ok" },
    ],
    actionStartsMs: { open: 1_500, run: 17_200 },
    finalWorkspaceHash: "abc123",
    captionText: "hello\nworld",
    audioSha256: "feedbeef",
    consoleLines: ["[go-run] go run main.go", "ok", "[go-run] Program exited"],
    previewState: { finalRoute: null, checkpoints: [] },
    previewInteractionSequence: [],
    durationMs: 21_778,
    ...overrides,
  };
}

function failedIds(checks: { id: string; ok: boolean }[]): string[] {
  return checks.filter((check) => !check.ok).map((check) => check.id);
}

describe("compareRenderSemantics", () => {
  it("passes two identical runs", () => {
    expect(failedIds(compareRenderSemantics(makeSemantics(), makeSemantics()))).toEqual([]);
  });

  it("tolerates timing drift within the tolerance", () => {
    const second = makeSemantics({
      actionStartsMs: { open: 1_650, run: 17_050 },
      durationMs: 21_900,
    });
    expect(failedIds(compareRenderSemantics(makeSemantics(), second))).toEqual([]);
  });

  it("flags timing drift beyond the tolerance", () => {
    const second = makeSemantics({ actionStartsMs: { open: 1_500, run: 17_950 } });
    expect(failedIds(compareRenderSemantics(makeSemantics(), second))).toEqual([
      "repeat.actionTiming",
    ]);
  });

  it("flags diverged workspace, console, captions, audio, and sequence", () => {
    const second = makeSemantics({
      actionSequence: [
        { actionId: "open", actionType: "workspace.openFile", status: "ok" },
        { actionId: "run", actionType: "runtime.run", status: "failed" },
      ],
      finalWorkspaceHash: "different",
      captionText: "hello",
      audioSha256: "other",
      consoleLines: ["different"],
    });
    const failed = failedIds(compareRenderSemantics(makeSemantics(), second));
    expect(failed).toContain("repeat.actionSequence");
    expect(failed).toContain("repeat.finalWorkspace");
    expect(failed).toContain("repeat.captions");
    expect(failed).toContain("repeat.audio");
    expect(failed).toContain("repeat.console");
  });

  it("flags duration drift beyond the tolerance", () => {
    const second = makeSemantics({ durationMs: 23_000 });
    expect(failedIds(compareRenderSemantics(makeSemantics(), second))).toEqual(["repeat.duration"]);
  });

  it("flags diverged normalized preview state and interaction sequence", () => {
    const first = makeSemantics({
      previewState: {
        finalRoute: "/done",
        checkpoints: [{ actionId: "assert", route: "/done" }],
      },
      previewInteractionSequence: [{ type: "click", testId: "submit" }],
    });
    const second = makeSemantics({
      previewState: {
        finalRoute: "/wrong",
        checkpoints: [{ actionId: "assert", route: "/wrong" }],
      },
      previewInteractionSequence: [{ type: "click", testId: "cancel" }],
    });

    expect(failedIds(compareRenderSemantics(first, second))).toEqual([
      "repeat.previewState",
      "repeat.previewInteractions",
    ]);
  });

  describe("action timing against where each action was due", () => {
    // A preview that loads in 1.8 s in one render and 4.3 s in the other: the
    // expectation chained after it starts 2.5 s apart, and so does the dock
    // collapse chained after that. Neither is late for anything.
    const chain = (previewLoadMs: number, selectDriftMs = 0): Partial<RenderSemantics> => ({
      actionSequence: [
        { actionId: "open-preview", actionType: "preview.open", status: "ok" },
        { actionId: "expect-title", actionType: "expect.preview", status: "ok" },
        { actionId: "collapse-dock", actionType: "runtime.collapseDock", status: "ok" },
        { actionId: "select-state", actionType: "editor.select", status: "ok" },
      ],
      actionStartsMs: {
        "open-preview": 74_000,
        "expect-title": 74_000 + previewLoadMs,
        "collapse-dock": 74_010 + previewLoadMs,
        "select-state": 80_000 + selectDriftMs,
      },
      actionDriftsMs: { "open-preview": 5, "collapse-dock": 2, "select-state": selectDriftMs },
    });

    it("passes when only an action chained after a preview load starts at another time", () => {
      const checks = compareRenderSemantics(
        makeSemantics(chain(1_830)),
        makeSemantics(chain(4_340)),
      );
      expect(failedIds(checks)).toEqual([]);
    });

    it("fails, and names the action, when the wait made a narrated action late", () => {
      const checks = compareRenderSemantics(
        makeSemantics(chain(1_830)),
        makeSemantics(chain(4_340, 1_900)),
      );
      expect(failedIds(checks)).toEqual(["repeat.actionTiming"]);
      expect(checks.find((check) => check.id === "repeat.actionTiming")?.detail).toBe(
        'worst action-start delta 1900ms at "select-state" (tolerance 300ms)',
      );
    });

    it("compares raw starts against a baseline stored without drifts", () => {
      const { actionDriftsMs: _dropped, ...stored } = makeSemantics(chain(1_830));
      const checks = compareRenderSemantics(stored, makeSemantics(chain(4_340)));
      expect(checks.find((check) => check.id === "repeat.actionTiming")?.detail).toBe(
        'worst action-start delta 2510ms at "expect-title" (tolerance 300ms)',
      );
    });
  });
});
