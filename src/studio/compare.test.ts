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
});
