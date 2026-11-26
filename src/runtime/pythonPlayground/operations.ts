import type { PlaygroundFile } from "../playgroundContract";
import {
  bootPythonInterpreter,
  type PythonInterpreter,
  type PythonInterpreterOptions,
} from "./interpreter";
import type { PythonPlaygroundRunResult } from "./types";

// What a Run asks of an interpreter, written once for both places it runs:
// `python.worker.ts` exposes one of these as it is, and the client makes one in
// this page only where there is no Worker (tests, Node hosts).

/**
 * The operations a client drives on one interpreter, started on first use. One
 * of these is one `python` process: the client runs a single program on it and
 * then ends it.
 */
export function createPythonOperations(options: PythonInterpreterOptions = {}) {
  let pending: Promise<PythonInterpreter> | null = null;
  const interpreter = (): Promise<PythonInterpreter> => {
    pending ??= bootPythonInterpreter(options).catch((error: unknown) => {
      // A failed start (offline, a stale tab after a deploy) is not kept: the
      // next call tries again, as loadKiteCompiler does.
      pending = null;
      throw error;
    });
    return pending;
  };

  return {
    /** Start the interpreter, so a failed start is told apart from a failed run. */
    async load(): Promise<void> {
      await interpreter();
    },
    /** Run the script at `entryPath`, with `files` written beside it. */
    async run(
      files: readonly PlaygroundFile[],
      entryPath: string,
    ): Promise<PythonPlaygroundRunResult> {
      return (await interpreter()).run(files, entryPath);
    },
  };
}

export type PythonOperations = ReturnType<typeof createPythonOperations>;
