import type { PlaygroundLanguage } from "../playgroundLanguage";
import {
  PythonPlaygroundClient,
  PythonPlaygroundServiceError,
  pickPythonRunEntry,
  type PythonPlaygroundServiceErrorKind,
} from "./client";
import {
  pythonRunResultToConsoleLines,
  pythonRunServiceErrorToConsoleLines,
  pythonRunStartedConsoleLines,
} from "./console";
import { collectPythonPlaygroundFiles } from "./files";
import type { PythonPlaygroundRunResult } from "./types";

/**
 * Python lessons, where **there is no service**, as with Kite and assembly.
 * The interpreter is CPython built to WebAssembly (Pyodide): Run starts it in
 * a worker of this page and answers without a network round trip — no proxy,
 * no rate limit, and no lesson that breaks because a public playground is
 * down. Cancelling terminates the worker, the only way to stop a program that
 * never returns.
 *
 * A run is `python main.py` with every text file of the workspace beside it:
 * the other `.py` files import as modules and the rest open as data (the
 * client says so plainly when several scripts exist and none is named
 * `main.py`). Every run gets an interpreter of its own, so what one program
 * did never reaches the next.
 *
 * A run is interactive: on a terminal the program prints as it goes, and
 * `input()` waits for the line typed there.
 *
 * There is no Format: Python's standard library has no formatter, and the
 * ones people use are packages this runtime does not carry.
 */
export const PYTHON_PLAYGROUND: PlaygroundLanguage<
  PythonPlaygroundClient,
  PythonPlaygroundServiceErrorKind,
  PythonPlaygroundRunResult
> = {
  label: "python",
  client: {
    create: () => new PythonPlaygroundClient(),
    stop: (client) => client.dispose(),
    ServiceError: PythonPlaygroundServiceError,
  },
  collectFiles: collectPythonPlaygroundFiles,
  run: {
    commandLabel: "python main.py",
    // No rejectFiles: which script is the program is the client's call, so a
    // workspace it cannot resolve comes back as its own message rather than a
    // guess here.
    pickEntry: pickPythonRunEntry,
    execute: (client, files) => client.run({ files }),
    interactive: {
      execute: (client, files, terminal) => client.run({ files }, terminal),
    },
    startedLines: pythonRunStartedConsoleLines,
    resultLines: pythonRunResultToConsoleLines,
    serviceErrorLines: pythonRunServiceErrorToConsoleLines,
  },
  format: null,
};
