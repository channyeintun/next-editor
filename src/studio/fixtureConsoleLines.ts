import { asmRunConsoleLines } from "../runtime/asmPlayground/console";
import { goRunResultToConsoleLines } from "../runtime/goPlayground/console";
import { haskellRunResultToConsoleLines } from "../runtime/haskellPlayground/console";
import { kiteRunResultToConsoleLines } from "../runtime/kitePlayground/console";
import { kotlinRunResultToConsoleLines } from "../runtime/kotlinPlayground/console";
import { rustRunResultToConsoleLines } from "../runtime/rustPlayground/console";
import { zigRunResultToConsoleLines } from "../runtime/zigPlayground/console";
import { CLEAN_RUN_STATUS, pinnedRunResult, pinnedRunStatus } from "./fixtureRuns";
import type { StudioPlaygroundRuntime } from "./plan";

/**
 * The console lines a Playground lesson's pinned run `runActionId` prints after
 * its header line — the program's output plus whatever the runner adds around
 * it (vet and compiler warnings first, stderr, an assembly lesson's registers,
 * the exit line), built by the same console builders a live run's result goes
 * through. Which result a run replays is fixtureRuns.ts's rule. It is the one
 * fixture console path: a fixture-mode run prints these lines
 * (playgroundRuntime's `preparePlaygroundRun`), and because it is pure (no
 * client is loaded) the script schema and the compiler (script/consolePoints.ts)
 * check `console.point` and `expect.output` against it before any narration is
 * synthesized.
 */
export function fixtureRunConsoleLines(
  runtime: StudioPlaygroundRuntime,
  runActionId: string,
): string[] {
  switch (runtime.kind) {
    case "go-playground":
      return goRunResultToConsoleLines(pinnedRunResult(runtime.fixture, runActionId));
    case "kotlin-playground":
      return kotlinRunResultToConsoleLines(pinnedRunResult(runtime.fixture, runActionId));
    case "rust-playground":
      return rustRunResultToConsoleLines(pinnedRunResult(runtime.fixture, runActionId));
    case "zig-playground":
      return zigRunResultToConsoleLines(pinnedRunResult(runtime.fixture, runActionId));
    case "haskell-playground":
      return haskellRunResultToConsoleLines(pinnedRunResult(runtime.fixture, runActionId));
    case "kite-playground":
      return kiteRunResultToConsoleLines(pinnedRunResult(runtime.fixture, runActionId));
    case "asm-playground":
      return asmRunConsoleLines(pinnedRunResult(runtime.fixture, runActionId));
  }
}

/**
 * The console lines of every run in `runActionIds` that the fixture pins to
 * fail (a compile error, a vet error, a runtime error) — the error lines a
 * lesson about that failure prints on purpose. The driver's `expect.output` and
 * the QA gate's error-line check skip exactly these, and nothing else.
 */
export function pinnedFailureConsoleLines(
  runtime: StudioPlaygroundRuntime,
  runActionIds: readonly string[],
): string[] {
  return runActionIds.flatMap((runActionId) =>
    pinnedRunStatus(runtime.fixture, runActionId) === CLEAN_RUN_STATUS
      ? []
      : fixtureRunConsoleLines(runtime, runActionId),
  );
}

/** A line as the console shows it: a tab advances to the next 8-column stop. */
export function expandConsoleTabs(line: string): string {
  let shown = "";
  for (const character of line) {
    shown += character === "\t" ? " ".repeat(8 - (shown.length % 8)) : character;
  }
  return shown;
}
