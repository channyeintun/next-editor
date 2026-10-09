import { isPlaygroundRuntime } from "../plan";
import { CONSOLE_MIN_COLUMNS, CONSOLE_VISIBLE_ROWS } from "../consoleLines";
import { expandConsoleTabs, fixtureRunConsoleLines } from "../fixtureConsoleLines";
import type { LessonScript } from "./schema";

// Runner lines that are warnings about the program, not its output. A point
// whose text also appears in one would land on the warning first.
const RUNNER_WARNING_LINE = /^\[(?:go-vet|kotlin-warn|haskell-warn)\]/;

/**
 * Every way a lesson's `console.point`s cannot land, checked against the exact
 * console its pinned run prints (Playground lessons only — a WebContainer
 * console's output is not pinned). The text is matched as the console shows
 * it, tabs as spaces; the target has to be one the learner can see, which is
 * the last CONSOLE_VISIBLE_ROWS rows; and it must not resolve to a warning.
 * The script schema reports these, so they fail before any narration is
 * synthesized instead of at the pointer mid-render.
 */
export function consolePointIssues(script: Pick<LessonScript, "runtime" | "scenes">): string[] {
  if (!isPlaygroundRuntime(script.runtime)) return [];
  const lines = fixtureRunConsoleLines(script.runtime).map(expandConsoleTabs);
  const issues: string[] = [];
  for (const scene of script.scenes) {
    for (const action of scene.actions) {
      if (action.type !== "console.point") continue;
      const { text, occurrence } = action.target;
      const matching = lines.flatMap((line, index) => (line.includes(text) ? [index] : []));
      if (matching.length < occurrence) {
        issues.push(
          `console.point "${action.id}" targets output line ${occurrence} containing ${JSON.stringify(text)}, but the run's console has ${matching.length} such line${matching.length === 1 ? "" : "s"}`,
        );
        continue;
      }
      const index = matching[occurrence - 1];
      if (RUNNER_WARNING_LINE.test(lines[index]) && !RUNNER_WARNING_LINE.test(text)) {
        issues.push(
          `console.point "${action.id}" lands on the runner's warning line ${JSON.stringify(lines[index])} — make the text match only the output line you mean, or raise its occurrence`,
        );
        continue;
      }
      const rowsToBottom = lines
        .slice(index)
        .reduce(
          (rows, line) => rows + Math.max(1, Math.ceil(line.length / CONSOLE_MIN_COLUMNS)),
          0,
        );
      if (rowsToBottom > CONSOLE_VISIBLE_ROWS) {
        issues.push(
          `console.point "${action.id}" targets ${JSON.stringify(lines[index])}, which has scrolled out of the console by then: only its last ${CONSOLE_VISIBLE_ROWS} rows stay on screen (the exit line takes one) — point at a later line or print fewer lines`,
        );
      }
    }
  }
  return issues;
}
