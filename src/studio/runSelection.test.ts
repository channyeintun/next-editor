import { describe, expect, it } from "vite-plus/test";
import type { RenderSemantics } from "./compare";
import {
  appendCompletedRun,
  BASELINE_RESET_NOTE,
  checkRepeatability,
  runExposedForSelection,
  selectRepeatabilityBaseline,
  sourceRevisionOf,
  type PriorRunSemantics,
} from "./runSelection";

function semanticsWithHash(planSha256: string): RenderSemantics {
  return {
    planSha256,
    actionSequence: [],
    actionStartsMs: {},
    finalWorkspaceHash: "hash",
    captionText: "",
    audioSha256: "audio",
    consoleLines: [],
    previewState: { finalRoute: null, checkpoints: [] },
    previewInteractionSequence: [],
    durationMs: 1_000,
  };
}

describe("sourceRevisionOf", () => {
  it("is stable for a built-in source across the session", () => {
    expect(sourceRevisionOf("rust-borrow", {})).toBe(sourceRevisionOf("rust-borrow", {}));
    expect(sourceRevisionOf("rust-borrow", {})).toBe("builtin:rust-borrow");
  });

  it("changes when an imported script of the same slug is re-imported with new content", () => {
    const first = sourceRevisionOf("my-lesson", { "my-lesson": "lesson:\n  slug: my-lesson\n" });
    const edited = sourceRevisionOf("my-lesson", { "my-lesson": "lesson:\n  slug: my-lesson\n#" });
    expect(first).not.toBe(edited);
    // Re-importing the same content is deterministic.
    expect(first).toBe(
      sourceRevisionOf("my-lesson", { "my-lesson": "lesson:\n  slug: my-lesson\n" }),
    );
  });

  it("distinguishes an imported script from a built-in of the same slug", () => {
    expect(sourceRevisionOf("shared", {})).not.toBe(sourceRevisionOf("shared", { shared: "yaml" }));
  });

  it("uses exact imported bytes rather than a collision-prone short hash", () => {
    const yaml = "lesson:\n  slug: exact\n";
    expect(sourceRevisionOf("exact", { exact: yaml })).toBe(`imported:${yaml}`);
  });

  it("keeps imported bytes disjoint from the built-in identity namespace", () => {
    const builtinRevision = sourceRevisionOf("exact", {});
    expect(sourceRevisionOf("exact", { exact: builtinRevision })).not.toBe(builtinRevision);
  });
});

describe("runExposedForSelection (STUDIO-02)", () => {
  const runA = { slug: "lesson-a", sourceRevision: "builtin:lesson-a" };

  it("exposes a completed run only for its own slug and revision when idle", () => {
    expect(runExposedForSelection(runA, "lesson-a", "builtin:lesson-a", false)).toBe(true);
  });

  it("does NOT expose run A's bundle once lesson B is selected", () => {
    // The core STUDIO-02 scenario: render A, then select B → A's artifact/draft
    // must not be offered under B.
    expect(runExposedForSelection(runA, "lesson-b", "builtin:lesson-b", false)).toBe(false);
  });

  it("does NOT expose a run while a new render is in flight", () => {
    expect(runExposedForSelection(runA, "lesson-a", "builtin:lesson-a", true)).toBe(false);
  });

  it("does NOT expose a run whose source revision changed (script re-imported)", () => {
    expect(runExposedForSelection(runA, "lesson-a", "imported:deadbeef", false)).toBe(false);
  });

  it("exposes nothing when there is no completed run", () => {
    expect(runExposedForSelection(null, "lesson-a", "builtin:lesson-a", false)).toBe(false);
  });
});

describe("appendCompletedRun", () => {
  interface Run {
    index: number;
    result: { report: string; semantics: RenderSemantics | null; artifacts: string | null };
  }
  const run = (index: number, artifacts: string | null): Run => ({
    index,
    result: { report: `report-${index}`, semantics: semanticsWithHash(`plan-${index}`), artifacts },
  });

  it("keeps the artifacts of the newest run only", () => {
    const history: Run[] = [];
    const first = run(1, "bundle-1");
    const second = run(2, "bundle-2");

    appendCompletedRun(history, first);
    expect(history).toEqual([first]);

    appendCompletedRun(history, second);
    expect(history[1]).toBe(second);
    expect(history[0]).toEqual({
      index: 1,
      result: { report: "report-1", semantics: semanticsWithHash("plan-1"), artifacts: null },
    });
  });

  it("copies the superseded run instead of mutating it", () => {
    const history: Run[] = [];
    const first = run(1, "bundle-1");
    appendCompletedRun(history, first);
    appendCompletedRun(history, run(2, null));

    expect(history[0]).not.toBe(first);
    expect(first.result.artifacts).toBe("bundle-1");
  });

  it("leaves a superseded run without artifacts as it was", () => {
    const failed = run(1, null);
    const history: Run[] = [failed];
    appendCompletedRun(history, run(2, "bundle-2"));

    expect(history[0]).toBe(failed);
    expect(history.map((entry) => entry.result.artifacts)).toEqual([null, "bundle-2"]);
  });
});

describe("selectRepeatabilityBaseline (STUDIO-04)", () => {
  const mode = "fixture" as const;
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);

  it("A → B → A compares the second A against the first A, not B", () => {
    // History before the second A finishes, most-recent last: [A, B].
    const priorRuns: PriorRunSemantics[] = [
      { mode, outcome: "passed", semantics: semanticsWithHash(hashA) },
      { mode, outcome: "passed", semantics: semanticsWithHash(hashB) },
    ];
    const baseline = selectRepeatabilityBaseline(priorRuns, mode, hashA, null);
    expect(baseline?.planSha256).toBe(hashA);
  });

  it("ignores same-mode runs whose plan hash differs (does not pick B for an A render)", () => {
    const priorRuns: PriorRunSemantics[] = [
      { mode, outcome: "passed", semantics: semanticsWithHash(hashB) },
    ];
    expect(selectRepeatabilityBaseline(priorRuns, mode, hashA, null)).toBeNull();
  });

  it("ignores history from a different runtime mode", () => {
    const priorRuns: PriorRunSemantics[] = [
      { mode: "live", outcome: "passed", semantics: semanticsWithHash(hashA) },
    ];
    expect(selectRepeatabilityBaseline(priorRuns, mode, hashA, null)).toBeNull();
  });

  it("falls back to the stored baseline when history has no matching run", () => {
    const stored = semanticsWithHash(hashA);
    expect(selectRepeatabilityBaseline([], mode, hashA, stored)).toBe(stored);
  });

  it("prefers the most recent matching history run over the stored baseline", () => {
    const stored = semanticsWithHash(hashA);
    const recent = semanticsWithHash(hashA);
    const priorRuns: PriorRunSemantics[] = [
      { mode, outcome: "passed", semantics: semanticsWithHash(hashA) },
      { mode, outcome: "passed", semantics: recent },
    ];
    expect(selectRepeatabilityBaseline(priorRuns, mode, hashA, stored)).toBe(recent);
  });

  it("returns a hash-mismatched stored baseline so callers can surface a reset", () => {
    // checkRepeatability's trailing planSha256 guard turns this into a "script
    // changed" reset rather than a false comparison.
    const stored = semanticsWithHash(hashB);
    expect(selectRepeatabilityBaseline([], mode, hashA, stored)).toBe(stored);
  });

  it("does not use a failed render as a repeatability baseline", () => {
    const failed = semanticsWithHash(hashA);
    expect(
      selectRepeatabilityBaseline(
        [{ mode, outcome: "failed", semantics: failed }],
        mode,
        hashA,
        null,
      ),
    ).toBeNull();
  });
});

describe("checkRepeatability (STUDIO-04)", () => {
  const mode = "fixture" as const;
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);

  it("compares against a baseline rendered from the same plan", () => {
    const outcome = checkRepeatability(
      [{ mode, outcome: "passed", semantics: semanticsWithHash(hashA) }],
      mode,
      semanticsWithHash(hashA),
      null,
    );

    expect(outcome.baselineNote).toBeNull();
    expect(outcome.comparison?.length).toBeGreaterThan(0);
    expect(outcome.comparison?.every((check) => check.ok)).toBe(true);
  });

  it("reports what changed between two renders of the same plan", () => {
    const outcome = checkRepeatability(
      [{ mode, outcome: "passed", semantics: semanticsWithHash(hashA) }],
      mode,
      { ...semanticsWithHash(hashA), finalWorkspaceHash: "other" },
      null,
    );

    const workspaceCheck = outcome.comparison?.find(
      (check) => check.id === "repeat.finalWorkspace",
    );
    expect(workspaceCheck?.ok).toBe(false);
  });

  it("resets with a note when the only baseline came from an edited script", () => {
    const outcome = checkRepeatability(
      [],
      mode,
      semanticsWithHash(hashA),
      semanticsWithHash(hashB),
    );

    expect(outcome).toEqual({ comparison: null, baselineNote: BASELINE_RESET_NOTE });
  });

  it("neither compares nor notes anything without a baseline", () => {
    expect(checkRepeatability([], mode, semanticsWithHash(hashA), null)).toEqual({
      comparison: null,
      baselineNote: null,
    });
  });

  it("uses a matching earlier render over a stored baseline from an edited script", () => {
    const outcome = checkRepeatability(
      [{ mode, outcome: "passed", semantics: semanticsWithHash(hashA) }],
      mode,
      semanticsWithHash(hashA),
      semanticsWithHash(hashB),
    );

    expect(outcome.baselineNote).toBeNull();
    expect(outcome.comparison).not.toBeNull();
  });
});
