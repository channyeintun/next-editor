import { isPlaygroundRuntime, type StudioPlaygroundRuntime } from "../plan";
import { CONSOLE_MIN_COLUMNS, CONSOLE_VISIBLE_ROWS } from "../consoleLines";
import { expandConsoleTabs, fixtureRunConsoleLines } from "../fixtureConsoleLines";
import { pinsResultPerRun, withLatestRun } from "../fixtureRuns";
import type { LessonScript, ScriptAction } from "./schema";

// Runner lines that are warnings about the program, not its output. A point
// whose text also appears in one would land on the warning first.
const RUNNER_WARNING_LINE = /^\[(?:go-vet|kotlin-warn|haskell-warn)\]/;

type ConsolePointAction = Extract<ScriptAction, { type: "console.point" }>;
type ExpectOutputAction = Extract<ScriptAction, { type: "expect.output" }>;
type ConsoleTargetAction = ConsolePointAction | ExpectOutputAction;

/** One run's pinned console, and how a message names it. */
interface RunConsole {
  /** The runtime.run id when the fixture pins one result per run, else null. */
  runId: string | null;
  lines: string[];
}

function consoleName(run: RunConsole): string {
  return run.runId === null ? "the run's console" : `runtime.run "${run.runId}"'s console`;
}

function isConsoleTarget(action: ScriptAction): action is ConsoleTargetAction {
  return action.type === "console.point" || action.type === "expect.output";
}

/**
 * Why `action` cannot land on `run`'s console, or null when it can. A point's
 * text is matched as the console shows it, tabs as spaces; the target has to
 * be one the learner can see, which is the last CONSOLE_VISIBLE_ROWS rows; and
 * it must not resolve to a warning. An `expect.output` needs a line holding
 * its text, matched as the driver and the QA gate match it.
 */
function consoleTargetIssue(action: ConsoleTargetAction, run: RunConsole): string | null {
  if (action.type === "expect.output") {
    return run.lines.some((line) => line.includes(action.contains))
      ? null
      : `expect.output "${action.id}" waits for a console line containing ${JSON.stringify(action.contains)}, but ${consoleName(run)} has none`;
  }
  const lines = run.lines.map(expandConsoleTabs);
  const { text, occurrence } = action.target;
  const matching = lines.flatMap((line, index) => (line.includes(text) ? [index] : []));
  if (matching.length < occurrence) {
    return `console.point "${action.id}" targets output line ${occurrence} containing ${JSON.stringify(text)}, but ${consoleName(run)} has ${matching.length} such line${matching.length === 1 ? "" : "s"}`;
  }
  const index = matching[occurrence - 1];
  if (RUNNER_WARNING_LINE.test(lines[index]) && !RUNNER_WARNING_LINE.test(text)) {
    return `console.point "${action.id}" lands on the runner's warning line ${JSON.stringify(lines[index])} — make the text match only the output line you mean, or raise its occurrence`;
  }
  const rowsToBottom = lines
    .slice(index)
    .reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / CONSOLE_MIN_COLUMNS)), 0);
  if (rowsToBottom > CONSOLE_VISIBLE_ROWS) {
    return `console.point "${action.id}" targets ${JSON.stringify(lines[index])}, which has scrolled out of the console by then: only its last ${CONSOLE_VISIBLE_ROWS} rows stay on screen (the exit line takes one) — point at a later line or print fewer lines`;
  }
  return null;
}

function runConsole(runtime: StudioPlaygroundRuntime, runId: string): RunConsole {
  return {
    runId: pinsResultPerRun(runtime.fixture) ? runId : null,
    lines: fixtureRunConsoleLines(runtime, runId),
  };
}

/**
 * Every `console.point` and `expect.output` that fits none of the lesson's
 * pinned runs (Playground lessons only — a WebContainer console's output is not
 * pinned). The script schema reports these when the script is parsed, before
 * any narration is synthesized. With one `result` every run prints the same
 * console, so this is the whole check. With `results`, which run a target
 * follows depends on the narration's timing; a target no run's console can
 * satisfy is wrong whatever the timing, and the compiler checks the rest
 * against the run it really follows (`consoleTargetIssuesInOrder`).
 */
export function consoleTargetIssues(script: Pick<LessonScript, "runtime" | "scenes">): string[] {
  const runtime = script.runtime;
  if (!isPlaygroundRuntime(runtime)) return [];
  const actions = script.scenes.flatMap((scene) => scene.actions);
  const runIds = actions.filter((action) => action.type === "runtime.run").map(({ id }) => id);
  const results = runtime.fixture.results;
  const runs: RunConsole[] =
    results === undefined
      ? // One result for every run; its run id is not read.
        [runConsole(runtime, runIds[0] ?? "")]
      : // A run with no entry is the runtime contract's to report.
        runIds.filter((id) => Object.hasOwn(results, id)).map((id) => runConsole(runtime, id));
  if (runs.length === 0) return [];

  const issues: string[] = [];
  for (const action of actions) {
    if (!isConsoleTarget(action)) continue;
    const runIssues: string[] = [];
    for (const run of runs) {
      const issue = consoleTargetIssue(action, run);
      if (issue === null) break;
      runIssues.push(issue);
    }
    if (runIssues.length < runs.length) continue;
    issues.push(
      runs.length === 1
        ? runIssues[0]
        : `${action.type} "${action.id}" fits none of the lesson's runs: ${runIssues.join("; ")}`,
    );
  }
  return issues;
}

/**
 * Every `console.point` and `expect.output` that does not fit the run it
 * follows: `ordered` is the lesson's actions in performance order, and each
 * target is checked against the most recent `runtime.run` before it
 * (fixtureRuns.ts's `withLatestRun`). A target before any run is the pointer
 * choreography's error, so it is skipped here.
 */
export function consoleTargetIssuesInOrder(
  runtime: LessonScript["runtime"],
  ordered: readonly ScriptAction[],
): string[] {
  if (!isPlaygroundRuntime(runtime)) return [];
  const issues: string[] = [];
  for (const { action, runId } of withLatestRun(ordered)) {
    if (runId === null || !isConsoleTarget(action)) continue;
    const issue = consoleTargetIssue(action, runConsole(runtime, runId));
    if (issue !== null) issues.push(issue);
  }
  return issues;
}
