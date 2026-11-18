// What a program under `node --watch` tells its supervisor: Node's watch-mode
// messages (lib/internal/watch_mode/files_watcher.js). The supervisor sets
// WATCH_REPORT_DEPENDENCIES for its program, and the program sends each file
// it loads over its IPC channel: `{ "watch:require": [path] }` for one it
// required, `{ "watch:import": [url] }` for one it imported. A worker thread
// posts the same messages on its parentPort and the main thread passes them
// on (node/worker_threads.ts); the supervisor reads them in watch.ts.
// Nothing here imports anything.

/** The variable a `node --watch` supervisor sets for its program. */
const REPORT_VARIABLE = "WATCH_REPORT_DEPENDENCIES";

/** How a file was loaded: `require()` reports its path, `import` its URL. */
export type WatchReportKind = "require" | "import";

const KEYS: Readonly<Record<WatchReportKind, string>> = {
  require: "watch:require",
  import: "watch:import",
};

/** What the supervisor adds to its program's environment to ask for the reports. */
export const WATCH_REPORT_ENV: Readonly<Record<string, string>> = { [REPORT_VARIABLE]: "1" };

/** Whether the process with `env` was asked to report what it loads. */
export function watchReportsWanted(env: Record<string, string | undefined>): boolean {
  return Boolean(env[REPORT_VARIABLE]);
}

/** The message that reports `files`: paths for `require`, URLs for `import`. */
export function watchReportMessage(
  kind: WatchReportKind,
  files: unknown[],
): Record<string, unknown[]> {
  return { [KEYS[kind]]: files };
}

/**
 * The reports `message` carries, one for each kind it has a list under; none
 * for any other message. What a thread's parent passes on is
 * `watchReportMessage(kind, files)` for each, as Node's lib/internal/worker.js
 * does.
 */
export function watchReportsIn(message: unknown): { kind: WatchReportKind; files: unknown[] }[] {
  if (message === null || typeof message !== "object") {
    return [];
  }
  const reports: { kind: WatchReportKind; files: unknown[] }[] = [];
  for (const kind of ["require", "import"] as const) {
    const files = (message as Record<string, unknown>)[KEYS[kind]];
    if (Array.isArray(files)) {
      reports.push({ kind, files });
    }
  }
  return reports;
}
