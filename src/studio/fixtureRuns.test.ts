import { describe, expect, it } from "vite-plus/test";
import {
  pinnedRunFixtureShapeIssue,
  pinnedRunIdIssues,
  pinnedRunResult,
  pinnedRunStatus,
  runOutcomeIssue,
  withLatestRun,
} from "./fixtureRuns";

const clean = { status: "success" };
const broken = { status: "compile-error" };

describe("pinnedRunResult", () => {
  it("replays one `result` for every run", () => {
    expect(pinnedRunResult({ result: clean }, "run-1")).toBe(clean);
    expect(pinnedRunResult({ result: clean }, "anything")).toBe(clean);
  });

  it("replays each run's own entry from `results`", () => {
    const fixture = { results: { "run-1": clean, "run-2": broken } };
    expect(pinnedRunResult(fixture, "run-1")).toBe(clean);
    expect(pinnedRunStatus(fixture, "run-2")).toBe("compile-error");
    expect(() => pinnedRunResult(fixture, "run-3")).toThrow(/no result for runtime.run "run-3"/);
    // An own-key lookup: a prototype key is not a run.
    expect(() => pinnedRunResult(fixture, "constructor")).toThrow(/no result/);
  });
});

describe("pinnedRunFixtureShapeIssue", () => {
  it("wants exactly one of `result` and `results`", () => {
    expect(pinnedRunFixtureShapeIssue({ result: clean })).toBeNull();
    expect(pinnedRunFixtureShapeIssue({ results: {} })).toBeNull();
    expect(pinnedRunFixtureShapeIssue({ result: clean, results: {} })).toMatch(/not both/);
    expect(pinnedRunFixtureShapeIssue({})).toMatch(/needs `result`/);
  });
});

describe("pinnedRunIdIssues", () => {
  const actions = [
    { id: "run-1", type: "runtime.run" },
    { id: "type-1", type: "editor.type" },
    { id: "run-2", type: "runtime.run" },
  ];

  it("has nothing to say about one `result`", () => {
    expect(pinnedRunIdIssues({ result: clean }, actions)).toEqual([]);
  });

  it("accepts exactly one entry per run", () => {
    expect(pinnedRunIdIssues({ results: { "run-1": clean, "run-2": clean } }, actions)).toEqual([]);
  });

  it("names a missing run and every key that is not a run", () => {
    expect(
      pinnedRunIdIssues({ results: { "run-1": clean, "type-1": clean, ghost: clean } }, actions),
    ).toEqual([
      'Action "run-2" (runtime.run) has no pinned result — add "run-2" to runtime.fixture.results',
      'runtime.fixture.results has an entry for "type-1", but action "type-1" has type editor.type, not runtime.run — every key must be a runtime.run action id',
      'runtime.fixture.results has an entry for "ghost", which is not the id of any action — every key must be a runtime.run action id',
    ]);
  });
});

describe("withLatestRun", () => {
  it("pairs each action with the run before it", () => {
    const ordered = [
      { id: "point-0", type: "console.point" },
      { id: "run-1", type: "runtime.run" },
      { id: "point-1", type: "console.point" },
      { id: "run-2", type: "runtime.run" },
      { id: "check", type: "expect.output" },
    ];
    expect(withLatestRun(ordered).map(({ action, runId }) => [action.id, runId])).toEqual([
      ["point-0", null],
      ["run-1", null],
      ["point-1", "run-1"],
      ["run-2", "run-1"],
      ["check", "run-2"],
    ]);
  });
});

describe("runOutcomeIssue", () => {
  const fixture = { results: { "run-1": clean, "run-2": broken } };

  it("accepts the pinned status, clean or not", () => {
    expect(runOutcomeIssue(fixture, "run-1", "success")).toBeNull();
    expect(runOutcomeIssue(fixture, "run-2", "compile-error")).toBeNull();
  });

  it("keeps the clean-run message for a run pinned to succeed", () => {
    expect(runOutcomeIssue(fixture, "run-1", "runtime-error")).toBe(
      "The program did not run cleanly (status runtime-error)",
    );
  });

  it("refuses a run that succeeds where the lesson pins a compile error", () => {
    expect(runOutcomeIssue(fixture, "run-2", "success")).toBe(
      'The program ended with status success, but runtime.run "run-2" is pinned to end with compile-error',
    );
  });
});
