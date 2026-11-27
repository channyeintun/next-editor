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
 * The lesson-boundary reset, run by every runner panel on a load or a new
 * project id (a live room's file changes are not a boundary). Unlike
 * `clearRunnerConsole`, which drops one named surface's scroll entry, this
 * wipes the whole `terminalScrollLines` map: at a project boundary a leftover
 * entry can belong to a *different* language's runner from the previous
 * lesson, and every one of them is now stale. It lives here rather than
 * inlined in each panel so a new thing the reset must touch is added once, for
 * all seven languages, instead of in seven files minus the one forgotten.
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

/** A running operation's lines in the console, replaced as more of them arrive. */
export interface RunnerConsoleStream {
  /**
   * Shows `lines` as everything the operation has printed so far, in place of
   * what the last call showed. A program's output arrives in pieces, and a
   * piece can end in the middle of a line (a prompt waiting for its answer),
   * so the lines are given whole each time rather than appended: the line left
   * open is simply longer in the next call.
   */
  show(lines: readonly string[]): void;
}

/**
 * Opens the console for an operation that prints while it runs, after its
 * started lines (`beginRunnerOperation`). The lines sit after whatever the
 * console held at the first `show`. When something else writes the console in
 * between — the Clear button — the lines shown until then are gone for good:
 * later calls show only what came after them, so a Clear is never undone.
 */
export function openRunnerConsoleStream(store: RuntimePanelStoreInstance): RunnerConsoleStream {
  /** The console under the operation's lines. */
  let base: readonly string[] = [];
  /** How many of the operation's lines a Clear took, and how many the last call held. */
  let cleared = 0;
  let held = 0;
  /** The array this stream last put in the store, which nothing else holds. */
  let shown: string[] | null = null;

  return {
    show(lines) {
      const current = store.getSnapshot().context.consoleLines;
      if (current !== shown) {
        base = current;
        cleared = held;
      }
      held = lines.length;
      // Only the last lines can stay, so no more than those are copied: a
      // program can print 256 KiB of one-character lines.
      const kept = lines.slice(Math.max(cleared, lines.length - MAX_RUNNER_CONSOLE_LINES));
      shown = [...base, ...kept].slice(-MAX_RUNNER_CONSOLE_LINES);
      store.trigger.setConsoleLines({ consoleLines: shown });
    },
  };
}
