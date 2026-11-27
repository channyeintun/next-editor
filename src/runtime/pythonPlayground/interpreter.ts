// CPython, as WebAssembly.
//
// The interpreter is Pyodide: the CPython source itself built with Emscripten,
// with the standard library beside it. That is what makes a lesson's traceback
// the traceback — the same `traceback` module prints it — and what a
// reimplementation of Python could not promise.
//
// The package's loader (`pyodide.mjs`, a few kilobytes) is bundled with the
// code that imports it; the interpreter itself is four files it fetches from
// `indexURL`: `pyodide.asm.mjs`, `pyodide.asm.wasm`, `python_stdlib.zip` and
// `pyodide-lock.json`. The app serves them from its own origin
// (build/pyodideAssetsPlugin.ts), so a run reaches no other host. Nothing else
// is ever fetched: there is no package index here, so a program has the
// standard library and the lesson's own files.

import type { PlaygroundFile } from "../playgroundContract";
import { fetchPythonBinary } from "./interpreterBinary";
import type { PythonPlaygroundRunResult } from "./types";

/**
 * The most a program may print before the runner stops it, the budget the
 * assembly machine sets too. A playground service cuts a runaway program's
 * output on its side; this interpreter prints straight into the page, where
 * `while True: print(…)` would otherwise grow one string until the tab died.
 */
export const PYTHON_MAX_OUTPUT_BYTES = 256 * 1024;

export const PYTHON_OUTPUT_LIMIT_DETAIL =
  "The program printed more than 256 KiB and was stopped — look for a loop that never ends";

/**
 * How long a program may run, counted from its first line, not from the
 * interpreter's start, and not while it waits at `input()`: that time is the
 * learner's. The dock has no Stop button, and the mistake a Python lesson
 * meets most is a loop that never ends: without a limit it would hold a
 * processor until the next Run. Ten seconds is the Rust Playground's limit too.
 */
export const PYTHON_MAX_RUN_MS = 10_000;

export const PYTHON_TIME_LIMIT_DETAIL =
  "The program ran for more than 10 seconds and was stopped — look for a loop that never ends";

export const PYTHON_STOPPED_DETAIL =
  "Python stopped unexpectedly — the program may have run out of memory";

/** Where a run's files are written, and so the folder a traceback names. */
const LESSON_ROOT = "/lesson";

/**
 * `python <entry>`, in Python: the interpreter is already running, so there is
 * no command line to hand the script to. `run_program` answers a JSON object
 * of the exit status and, for two failures only this runner can explain, which
 * one it was; `finish_program` does what the interpreter does on its way out.
 *
 * It lives in a namespace of its own and runs the script through `runpy`, so
 * the script gets a fresh `__main__` and sees none of this.
 */
const DRIVER = `
import atexit
import json
import os
import runpy
import sys


def exit_status(code):
    # What a shell reads back: no code is success, an integer is taken modulo
    # 256, and anything else is printed to standard error as a failure.
    if code is None:
        return 0
    if isinstance(code, int):
        return code & 0xFF
    print(code, file=sys.stderr)
    return 1


def explain(error):
    # The two failures that are this runner's doing, not the program's.
    if type(error) is EOFError:
        return {"kind": "end-of-input"}
    if isinstance(error, ModuleNotFoundError) and error.name:
        return {"kind": "no-module", "name": error.name}
    return None


def run_program(entry):
    sys.argv = [entry]
    # \`python script.py\` puts the script's folder first on the import path and
    # leaves the current directory off it.
    sys.path[:] = [os.path.dirname(entry)] + [path for path in sys.path if path]
    hint = None
    try:
        runpy.run_path(entry, run_name="__main__")
        status = 0
    except SystemExit as exit:
        status = exit_status(exit.code)
    except BaseException as error:
        hint = explain(error)
        # The traceback starts at the script, as the interpreter's own does:
        # the frames above it are this runner's and runpy's.
        trace = error.__traceback__
        while trace is not None and trace.tb_frame.f_code.co_filename != entry:
            trace = trace.tb_next
        sys.excepthook(type(error), error, trace)
        status = 1
    return json.dumps({"status": status, "hint": hint})


def finish_program():
    atexit._run_exitfuncs()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except Exception:
            pass
`;

/** What `run_program` answers with. */
interface DriverAnswer {
  status: number;
  hint: { kind: "end-of-input" } | { kind: "no-module"; name: string } | null;
}

/**
 * Why a program that read standard input found its end: nothing here can wait
 * for a typed line, or the lines it was given ran out.
 */
type EndOfInput = { kind: "no-keyboard" } | { kind: "no-more-lines"; read: number };

function endOfInputHint(end: EndOfInput): string {
  if (end.kind === "no-keyboard") {
    return "input() has nothing to read: this page cannot wait for a typed line";
  }
  const given =
    end.read === 0 ? "no input" : `${end.read} line${end.read === 1 ? "" : "s"} of input`;
  return `input() has nothing left to read: the run was given ${given} and asked for another line`;
}

function hintText(hint: DriverAnswer["hint"], endOfInput: EndOfInput | null): string | undefined {
  if (hint?.kind === "end-of-input") {
    // An EOFError the program raised by itself is its own business.
    return endOfInput ? endOfInputHint(endOfInput) : undefined;
  }
  if (hint?.kind === "no-module") {
    return (
      `'${hint.name}' is not here: a program can import Python's standard library and this ` +
      "lesson's own .py files, and no package can be installed"
    );
  }
  return undefined;
}

export interface PythonInterpreterOptions {
  /**
   * The folder the interpreter's files are fetched from, with a trailing
   * slash. Left out under Node (tests), where the package finds its own files
   * beside its loader.
   */
  indexURL?: string;
  /** The run limit, for tests; {@link PYTHON_MAX_RUN_MS} otherwise. */
  maxRunMs?: number;
}

/**
 * What a run has in place of a screen and a keyboard. Both are optional: with
 * no `write` the output is only in the result, and with no `readLine` there is
 * nothing to read, so `input()` meets the end of its input at once.
 */
export interface PythonRunTerminal {
  /**
   * Takes the program's output as it is written: the bytes the output budget
   * keeps, in order, a typed line's echo among them. The bytes are a view the
   * next write reuses, so they are copied before this returns.
   */
  write?(bytes: Uint8Array): void;
  /**
   * The next line for the program, without its line break, or null at the end
   * of the input. It may block for as long as a learner takes to type: the run
   * limit does not count the time spent in it.
   */
  readLine?(): string | null;
}

/** A terminal whose input is `lines` and then its end: a run with its input typed ahead. */
export function pythonTerminalOfLines(lines: readonly string[]): PythonRunTerminal {
  let next = 0;
  return { readLine: () => (next < lines.length ? lines[next++] : null) };
}

export interface PythonInterpreter {
  /**
   * Run the script at `entryPath` with `files` written beside it, as
   * `python <entryPath>` in the lesson's folder would, on `terminal`.
   *
   * An interpreter keeps whatever a program did to it — its imported modules,
   * a changed `sys.path`, the files it wrote — so only a first run is the run
   * of a new `python` process. The client gives every run its own interpreter.
   */
  run(
    files: readonly PlaygroundFile[],
    entryPath: string,
    terminal?: PythonRunTerminal,
  ): Promise<PythonPlaygroundRunResult>;
}

/** Whether this JavaScript engine can suspend a WebAssembly call on a promise. */
function hasStackSwitching(): boolean {
  return typeof (WebAssembly as { Suspending?: unknown }).Suspending === "function";
}

/** The program's output, collected in the order it was written and cut at the budget. */
class OutputBuffer {
  readonly #chunks: Uint8Array[] = [];
  readonly #terminal: PythonRunTerminal | undefined;
  #length = 0;
  #sealed = false;
  overBudget = false;

  /** `terminal` is shown what the buffer keeps, as it keeps it. */
  constructor(terminal?: PythonRunTerminal) {
    this.#terminal = terminal;
  }

  /** Takes what still fits, and nothing once the buffer is sealed. */
  write(bytes: Uint8Array): void {
    if (this.#sealed) return;
    const room = PYTHON_MAX_OUTPUT_BYTES - this.#length;
    if (bytes.length > room) this.overBudget = true;
    const kept = bytes.subarray(0, Math.max(room, 0));
    if (kept.length > 0) {
      // Copied: the bytes are a view of the interpreter's memory, which the
      // next write reuses.
      this.#chunks.push(kept.slice());
      this.#length += kept.length;
      this.#terminal?.write?.(kept);
    }
  }

  /**
   * Take nothing more. A program the runner stops is ended with an interrupt,
   * and what Python prints about that — a KeyboardInterrupt traceback, cut
   * wherever the next interrupt lands — is the runner's doing, not output.
   */
  seal(): void {
    this.#sealed = true;
  }

  text(): string {
    const bytes = new Uint8Array(this.#length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    // A cut output ends at its last whole line, so the budget never leaves
    // half a line, or half a character, on the console.
    const end = this.overBudget ? bytes.lastIndexOf(10) + 1 || bytes.length : bytes.length;
    return new TextDecoder().decode(bytes.subarray(0, end));
  }
}

/**
 * Start an interpreter. The first call downloads and compiles it; the browser
 * caches both, so a later one costs about a second of start-up.
 */
export async function bootPythonInterpreter({
  indexURL,
  maxRunMs = PYTHON_MAX_RUN_MS,
}: PythonInterpreterOptions = {}): Promise<PythonInterpreter> {
  // A dynamic import, so the loader is fetched by a page that runs Python and
  // by no other.
  const { loadPyodide } = await import("pyodide");
  // In a page the WebAssembly file comes over the network, and the loader
  // never settles when it does not arrive: fetched first, a failure is one.
  if (indexURL) await fetchPythonBinary(indexURL);

  /** The running program's terminal, its output, and the lines it has read. */
  let terminal: PythonRunTerminal | undefined;
  let output = new OutputBuffer();
  let linesRead: string[] = [];
  let endOfInput: EndOfInput | null = null;
  /** When the running program is out of time; null while none is running. */
  let deadline: number | null = null;

  // Python asks for one line at a time, after writing the prompt. This blocks
  // the interpreter's thread until the terminal has the line.
  const readLine = (): string | null => {
    if (!terminal?.readLine) {
      endOfInput = { kind: "no-keyboard" };
      return null;
    }
    const askedAt = performance.now();
    const line = terminal.readLine();
    // Waiting for a person is not running: the limit moves by the time waited.
    if (deadline !== null) deadline += performance.now() - askedAt;
    if (line === null) {
      endOfInput = { kind: "no-more-lines", read: linesRead.length };
      return null;
    }
    linesRead.push(line);
    // Echoed as a terminal echoes what is typed, so the output reads as the
    // session did: the prompt, the answer on the same line, then what followed.
    const typed = `${line}\n`;
    output.write(new TextEncoder().encode(typed));
    return typed;
  };

  const pyodide = await loadPyodide({
    ...(indexURL ? { indexURL } : {}),
    // Unbuffered streams: each write reaches the page as it is made, which is
    // what keeps a traceback after the prints that came before it, and a
    // prompt on the screen before the program waits for its answer.
    env: { PYTHONUNBUFFERED: "1" },
    stdin: readLine,
  });

  const write = (bytes: Uint8Array): number => {
    output.write(bytes);
    return bytes.length;
  };
  pyodide.setStdout({ write });
  pyodide.setStderr({ write });

  // Pyodide reads cell 0 of its interrupt buffer every few bytecodes and
  // raises KeyboardInterrupt in the program when it holds a signal number.
  // The buffer is meant to be shared memory another thread writes to; this
  // one is an object whose cell 0 is computed when read, so the program is
  // ended from inside its own thread, with no second thread and no shared
  // memory, as soon as it is over its output budget or its time. It answers
  // the signal for as long as that holds, so a program that swallows one
  // interrupt meets the next.
  let outOfTime = false;
  const interrupt = {
    get 0(): number {
      if (deadline === null) return 0;
      outOfTime ||= performance.now() > deadline;
      if (!output.overBudget && !outOfTime) return 0;
      output.seal();
      return 2;
    },
    set 0(_cleared: number) {},
  };
  pyodide.setInterruptBuffer(interrupt as unknown as Uint8Array);

  const driver = pyodide.globals.get("dict")();
  pyodide.runPython(DRIVER, { globals: driver });
  const runProgram = driver.get("run_program");
  const finishProgram = driver.get("finish_program");

  const run = async (
    files: readonly PlaygroundFile[],
    entryPath: string,
    runTerminal?: PythonRunTerminal,
  ): Promise<PythonPlaygroundRunResult> => {
    for (const file of files) {
      const path = `${LESSON_ROOT}/${file.path}`;
      pyodide.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
      pyodide.FS.writeFile(path, file.content);
    }
    pyodide.FS.chdir(LESSON_ROOT);

    terminal = runTerminal;
    output = new OutputBuffer(runTerminal);
    linesRead = [];
    endOfInput = null;
    outOfTime = false;
    let answer: DriverAnswer | null = null;
    deadline = performance.now() + maxRunMs;
    try {
      const entry = `${LESSON_ROOT}/${entryPath}`;
      // Stack switching lets `asyncio.run` wait on the event loop; without it
      // the program still runs, and `asyncio.run` raises its own error.
      answer = JSON.parse(
        hasStackSwitching() ? await runProgram.callPromising(entry) : runProgram(entry),
      ) as DriverAnswer;
    } catch {
      // The interpreter died under the program, or an interrupt landed while
      // the driver was printing: `answer` stays null and is told below.
    }
    // No interrupt may land in what the interpreter does on its way out.
    deadline = null;
    try {
      finishProgram();
    } catch {
      // A dead interpreter cannot flush; what it printed is already here.
    }

    // The lines the program read are part of what the run was, when it read any.
    const ran = { output: output.text(), ...(linesRead.length > 0 ? { stdin: linesRead } : {}) };

    // A program can print past the budget and exit before the interpreter
    // next looks at the interrupt cell: its output is cut all the same.
    if (output.overBudget || outOfTime) {
      return {
        status: "runtime-error",
        ...ran,
        exitDetail: output.overBudget ? PYTHON_OUTPUT_LIMIT_DETAIL : PYTHON_TIME_LIMIT_DETAIL,
      };
    }
    if (!answer) {
      return { status: "runtime-error", ...ran, exitDetail: PYTHON_STOPPED_DETAIL };
    }
    if (answer.status === 0) {
      return { status: "success", ...ran };
    }
    const hint = hintText(answer.hint, endOfInput);
    return {
      status: "runtime-error",
      ...ran,
      exitCode: answer.status,
      ...(hint ? { hint } : {}),
    };
  };

  return { run };
}
