import type { RuntimePanelStoreInstance } from "../stores/runtimePanelStore";

/**
 * The one write path for playground-runner console lines into the shared
 * runtime panel store. Every runner panel and the studio performer append
 * through here so recorded console state is identical whichever surface drove
 * the run. It serves every language, so it lives beside the per-language
 * `runtime/*Playground` directories rather than inside one of them.
 */

// Bounds the recorded console state — every runtime recording event snapshots
// the full line array, so an unbounded log would bloat .ne recordings.
export const MAX_RUNNER_CONSOLE_LINES = 200;

/**
 * The matching clear for `appendRunnerConsoleLines`, behind the Clear button in
 * every playground dock. It drops the console's recorded scroll position as
 * well as its lines: `terminalScrollLines` is replayed verbatim as
 * XtermTerminal's `scrollLine`, so a position left over from a longer console
 * would replay as a scroll into rows that no longer exist.
 */
export function clearRunnerConsole(store: RuntimePanelStoreInstance, scrollSurface: string): void {
  const context = store.getSnapshot().context;

  if (context.consoleLines.length > 0) {
    store.trigger.setConsoleLines({ consoleLines: [] });
  }

  if (scrollSurface in context.terminalScrollLines) {
    store.trigger.setTerminalScrollLines({
      terminalScrollLines: Object.fromEntries(
        Object.entries(context.terminalScrollLines).filter(
          ([surface]) => surface !== scrollSurface,
        ),
      ),
    });
  }
}

/**
 * The lesson-boundary reset, run by every runner panel when the project
 * changes. Unlike `clearRunnerConsole`, which drops one named surface's scroll
 * entry, this wipes the whole `terminalScrollLines` map: at a project boundary
 * a leftover entry can belong to a *different* language's runner from the
 * previous lesson, and every one of them is now stale. It lives here rather
 * than inlined in each panel so a new thing the reset must touch is added once,
 * for all seven languages, instead of in seven files minus the one forgotten.
 */
export function resetRunnerConsoleForProject(store: RuntimePanelStoreInstance): void {
  const context = store.getSnapshot().context;

  if (context.consoleLines.length > 0) {
    store.trigger.setConsoleLines({ consoleLines: [] });
  }

  if (Object.keys(context.terminalScrollLines).length > 0) {
    store.trigger.setTerminalScrollLines({ terminalScrollLines: {} });
  }
}

function appendLines(
  store: RuntimePanelStoreInstance,
  lines: string[],
  startsOperation: boolean,
): void {
  if (lines.length === 0) {
    return;
  }

  const current = store.getSnapshot().context.consoleLines;
  // Blank separator between explicit tool operations keeps results readable.
  const separator = current.length > 0 && startsOperation ? [""] : [];
  store.trigger.setConsoleLines({
    consoleLines: [...current, ...separator, ...lines].slice(-MAX_RUNNER_CONSOLE_LINES),
  });
}

/**
 * Appends the lines that start a Run or Format (a language's `startedLines`),
 * with a blank separator from any output already in the console. The caller
 * marks the start: it is the one that knows it is beginning an operation.
 */
export function beginRunnerOperation(store: RuntimePanelStoreInstance, lines: string[]): void {
  appendLines(store, lines, true);
}

/**
 * Appends lines that continue the current operation: its result, a refusal or
 * an error. Never separated; `beginRunnerOperation` starts an operation.
 */
export function appendRunnerConsoleLines(store: RuntimePanelStoreInstance, lines: string[]): void {
  appendLines(store, lines, false);
}
