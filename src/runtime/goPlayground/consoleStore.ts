import type { RuntimePanelStoreInstance } from "../../stores/runtimePanelStore";

/**
 * The one write path for playground-runner console lines into the shared
 * runtime panel store. The runner panels and the studio performer append
 * through here so recorded console state is identical whichever surface
 * drove the run.
 */

// Bounds the recorded console state — every runtime recording event snapshots
// the full line array, so an unbounded log would bloat .ne recordings.
export const MAX_GO_CONSOLE_LINES = 200;

/** Lines that begin a new tool operation get a blank separator before them. */
const OPERATION_START_PREFIXES = [
  "[go-run] go run",
  "[gofmt] gofmt",
  "[kotlin-run] kotlin",
  "[rust-run] cargo run",
  "[rustfmt] rustfmt",
];

export function appendRunnerConsoleLines(store: RuntimePanelStoreInstance, lines: string[]): void {
  if (lines.length === 0) {
    return;
  }

  const current = store.getSnapshot().context.consoleLines;
  // Blank separator between explicit tool operations keeps results readable.
  const startsOperation = OPERATION_START_PREFIXES.some((prefix) => lines[0].startsWith(prefix));
  const separator = current.length > 0 && startsOperation ? [""] : [];
  store.trigger.setConsoleLines({
    consoleLines: [...current, ...separator, ...lines].slice(-MAX_GO_CONSOLE_LINES),
  });
}

/** Back-compat alias for the Go runner panel's original import. */
export const appendGoConsoleLines = appendRunnerConsoleLines;
