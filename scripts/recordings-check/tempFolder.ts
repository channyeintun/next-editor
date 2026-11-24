/**
 * The run's own temporary folder for downloaded recordings. Production recordings
 * are never kept: the folder is removed when the run ends, when it throws, and on
 * Ctrl-C, unless a person debugging asks to keep it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The signals that end a run from outside, and the exit code each gives. */
const ENDING_SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

type EndingSignal = keyof typeof ENDING_SIGNALS;

/** The parts of `process` the folder needs, so a test can hand in its own. */
export interface ProcessLike {
  on(signal: EndingSignal, listener: () => void): unknown;
  off(signal: EndingSignal, listener: () => void): unknown;
  exit(code: number): void;
}

export interface TempFolderOptions {
  /** Leave the folder in place when the run ends, for a person debugging. */
  keep: boolean;
  /** Where the folder goes; the system's temporary folder unless a test says. */
  parent?: string;
  process?: ProcessLike;
  /** Told the folder's path when it is kept. */
  onKept?: (path: string) => void;
}

/**
 * Runs `body` with a new, empty folder of its own, then removes it. A signal that
 * ends the run removes it too, before the process exits.
 */
export async function withTempFolder<T>(
  options: TempFolderOptions,
  body: (folder: string) => Promise<T>,
): Promise<T> {
  const host = options.process ?? process;
  const folder = mkdtempSync(join(options.parent ?? tmpdir(), "recordings-check-"));
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    for (const signal of Object.keys(ENDING_SIGNALS) as EndingSignal[]) {
      host.off(signal, listeners[signal]);
    }
    if (options.keep) options.onKept?.(folder);
    else rmSync(folder, { recursive: true, force: true });
  };
  const listeners = Object.fromEntries(
    (Object.keys(ENDING_SIGNALS) as EndingSignal[]).map((signal) => [
      signal,
      () => {
        end();
        host.exit(ENDING_SIGNALS[signal]);
      },
    ]),
  ) as Record<EndingSignal, () => void>;
  for (const signal of Object.keys(ENDING_SIGNALS) as EndingSignal[]) {
    host.on(signal, listeners[signal]);
  }
  try {
    return await body(folder);
  } finally {
    end();
  }
}
