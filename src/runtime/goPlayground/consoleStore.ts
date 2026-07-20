import type { RuntimePanelStoreInstance } from "../../stores/runtimePanelStore";

/**
 * The one write path for Go console lines into the shared runtime panel store.
 * The runner panel and the studio performer both append through here so
 * recorded console state is identical whichever surface drove the run.
 */

// Bounds the recorded console state — every runtime recording event snapshots
// the full line array, so an unbounded log would bloat .ne recordings.
export const MAX_GO_CONSOLE_LINES = 200;

export function appendGoConsoleLines(store: RuntimePanelStoreInstance, lines: string[]): void {
  if (lines.length === 0) {
    return;
  }

  const current = store.getSnapshot().context.consoleLines;
  // Blank separator between explicit tool operations keeps results readable.
  const startsOperation =
    lines[0].startsWith("[go-run] go run") || lines[0].startsWith("[gofmt] gofmt");
  const separator = current.length > 0 && startsOperation ? [""] : [];
  store.trigger.setConsoleLines({
    consoleLines: [...current, ...separator, ...lines].slice(-MAX_GO_CONSOLE_LINES),
  });
}
