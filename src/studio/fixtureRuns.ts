/**
 * Which pinned result a Playground run replays — the one rule for a lesson
 * that runs, changes its code, and runs again.
 *
 * A Playground fixture pins exactly one of:
 *
 * - `result`: every `runtime.run` replays it (a lesson whose program never
 *   changes between runs, or that runs once);
 * - `results`: a map from each `runtime.run` action's id to the result of the
 *   program as it stands at that run.
 *
 * Everything that needs "the result of this run" asks here: the fixture-mode
 * run (playgroundRuntime's `preparePlaygroundRun`), the console builders that
 * turn it into lines (fixtureConsoleLines.ts), the checks that a
 * `console.point` or `expect.output` fits the run before it
 * (script/consolePoints.ts), the driver deciding whether a run went as pinned,
 * and the QA gate that tells a pinned compile error from a broken render. The
 * per-kind result schemas stay in plan.ts; this module only knows that every
 * result carries a `status`.
 */

/** The fixture fields this rule reads, for any Playground kind's result shape. */
export interface PinnedRunFixture<Result> {
  result?: Result;
  results?: Readonly<Record<string, Result>>;
}

/** Every runner reports a clean run as "success"; anything else is a failure the lesson pins. */
export const CLEAN_RUN_STATUS = "success";

/**
 * The shape problem with a fixture, if any: it must hold exactly one of
 * `result` and `results`. The fixture schema (plan.ts's `playgroundFixture`)
 * reports it, so a parsed fixture always has one.
 */
export function pinnedRunFixtureShapeIssue(fixture: PinnedRunFixture<unknown>): string | null {
  const hasResult = fixture.result !== undefined;
  const hasResults = fixture.results !== undefined;
  if (hasResult && hasResults) {
    return "a fixture holds exactly one of `result` (every run replays it) or `results` (one result per runtime.run id), not both";
  }
  if (!hasResult && !hasResults) {
    return "a fixture needs `result` (every run replays it) or `results` (one result per runtime.run id)";
  }
  return null;
}

/** Whether the fixture pins one result per run rather than one for every run. */
export function pinsResultPerRun(fixture: PinnedRunFixture<unknown>): boolean {
  return fixture.results !== undefined;
}

/**
 * The result the run `runActionId` replays. Throws for a run with no entry —
 * the runtime contract (`pinnedRunIdIssues`) rejects that lesson at parse time,
 * so reaching it means a plan that skipped validation.
 */
export function pinnedRunResult<Result>(
  fixture: PinnedRunFixture<Result>,
  runActionId: string,
): Result {
  if (fixture.results !== undefined) {
    if (!Object.hasOwn(fixture.results, runActionId)) {
      throw new Error(`runtime.fixture.results has no result for runtime.run "${runActionId}"`);
    }
    return fixture.results[runActionId];
  }
  if (fixture.result === undefined) {
    throw new Error("runtime.fixture holds neither `result` nor `results`");
  }
  return fixture.result;
}

/** The status the run `runActionId` is pinned to end with. */
export function pinnedRunStatus(
  fixture: PinnedRunFixture<{ status: string }>,
  runActionId: string,
): string {
  return pinnedRunResult(fixture, runActionId).status;
}

/**
 * Every way a `results` map and the lesson's runs disagree: a run with no
 * entry, or an entry whose key is not the id of a `runtime.run` action. Both
 * schemas (script and plan) report these through the runtime contract. A
 * fixture with a single `result` covers every run, so it has none.
 */
export function pinnedRunIdIssues(
  fixture: PinnedRunFixture<unknown>,
  actions: ReadonlyArray<{ id: string; type: string }>,
): string[] {
  if (fixture.results === undefined) return [];
  const issues: string[] = [];
  const runIds = new Set<string>();
  const typeById = new Map<string, string>();
  for (const action of actions) {
    typeById.set(action.id, action.type);
    if (action.type !== "runtime.run") continue;
    runIds.add(action.id);
    if (!Object.hasOwn(fixture.results, action.id)) {
      issues.push(
        `Action "${action.id}" (runtime.run) has no pinned result — add "${action.id}" to runtime.fixture.results`,
      );
    }
  }
  for (const key of Object.keys(fixture.results)) {
    if (runIds.has(key)) continue;
    const type = typeById.get(key);
    issues.push(
      type === undefined
        ? `runtime.fixture.results has an entry for "${key}", which is not the id of any action — every key must be a runtime.run action id`
        : `runtime.fixture.results has an entry for "${key}", but action "${key}" has type ${type}, not runtime.run — every key must be a runtime.run action id`,
    );
  }
  return issues;
}

/**
 * Each action paired with the id of the most recent `runtime.run` before it,
 * in the order given (null before the first run). Given performance order, it
 * names the run whose output a `console.point` or `expect.output` reads —
 * the console's newest output is that run's.
 */
export function withLatestRun<Action extends { id: string; type: string }>(
  ordered: readonly Action[],
): Array<{ action: Action; runId: string | null }> {
  let runId: string | null = null;
  return ordered.map((action) => {
    const entry = { action, runId };
    if (action.type === "runtime.run") runId = action.id;
    return entry;
  });
}

/**
 * Why a run's outcome is not the one its fixture pins, or null when it is. A
 * fixture-mode run always matches; a live run must end with the pinned status
 * — a clean run where the lesson pins a compile error is as wrong as the
 * reverse. A lesson pinning only clean runs keeps the original message.
 */
export function runOutcomeIssue(
  fixture: PinnedRunFixture<{ status: string }>,
  runActionId: string,
  status: string,
): string | null {
  const pinned = pinnedRunStatus(fixture, runActionId);
  if (status === pinned) return null;
  return pinned === CLEAN_RUN_STATUS
    ? `The program did not run cleanly (status ${status})`
    : `The program ended with status ${status}, but runtime.run "${runActionId}" is pinned to end with ${pinned}`;
}
