import type { RuntimePanelStoreInstance } from "../stores/runtimePanelStore";

/**
 * The one write path for playground-runner console lines into the shared
 * runtime panel store. Every runner panel and the studio performer append
 * through here so recorded console state is identical whichever surface drove
 * the run — which only holds while this module knows about every language.
 * It lives beside the per-language `runtime/*Playground` directories rather
 * than inside one of them for exactly that reason.
 */

// Bounds the recorded console state — every runtime recording event snapshots
// the full line array, so an unbounded log would bloat .ne recordings.
export const MAX_RUNNER_CONSOLE_LINES = 200;

/**
 * Lines that begin a new tool operation get a blank separator before them.
 * Keep this in step with the `*StartedConsoleLines` builders in each
 * `runtime/<lang>Playground/console.ts`; a prefix missing here silently drops
 * the separator for that language only.
 */
export const OPERATION_START_PREFIXES = [
  "[go-run] go run",
  "[gofmt] gofmt",
  "[kotlin-run] kotlin",
  "[rust-run] cargo run",
  "[rustfmt] rustfmt",
  "[kite-run] kitec run",
  "[kitefmt] kitec fmt",
  "[zig-run] zig run",
  "[zig-fmt] zig fmt",
  "[haskell-run] runghc",
  "[asm-run] nasm",
];

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

export function appendRunnerConsoleLines(store: RuntimePanelStoreInstance, lines: string[]): void {
  if (lines.length === 0) {
    return;
  }

  const current = store.getSnapshot().context.consoleLines;
  // Blank separator between explicit tool operations keeps results readable.
  const startsOperation = OPERATION_START_PREFIXES.some((prefix) => lines[0].startsWith(prefix));
  const separator = current.length > 0 && startsOperation ? [""] : [];
  store.trigger.setConsoleLines({
    consoleLines: [...current, ...separator, ...lines].slice(-MAX_RUNNER_CONSOLE_LINES),
  });
}
