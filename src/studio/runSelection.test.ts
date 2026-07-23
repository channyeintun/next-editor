import { describe, expect, it } from "vite-plus/test";
import type { RenderSemantics } from "./compare";
import {
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
    // The controller's trailing planSha256 guard turns this into a "script
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
