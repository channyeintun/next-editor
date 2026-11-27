/**
 * Python run — the fixture `result` of a Python lesson, from the real
 * interpreter (docs/lesson-script-authoring.md, "Lesson types and runtime
 * kinds").
 *
 *   bun scripts/python-run.ts <folder>                       every file under the folder
 *   bun scripts/python-run.ts main.py helpers.py scores.csv  these files, by name
 *   bun scripts/python-run.ts src/studio/scripts/<slug>.yaml the script's pinned workspace
 *   bun scripts/python-run.ts --stdin Chan --stdin 42 <folder>
 *                                                            and these lines for input()
 *
 * A Python lesson runs on CPython built to WebAssembly, which runs under Bun
 * as it does in the page (src/runtime/pythonPlayground/interpreter.ts). So a
 * fixture does not have to be worked out by hand — a traceback's columns and
 * `~~^~~` marks cannot be: this runs `python main.py` over the files the same
 * way the dock does and prints the `result` to paste, as YAML, then the
 * console lines the lesson will show (what `console.point` and
 * `expect.output` are checked against).
 *
 * For a run after the lesson has typed more code, put the files as they are at
 * that run in a folder and pass the folder.
 *
 * A program that calls `input()` reads the `--stdin` lines, one for each call,
 * in the order given. The result then carries them as `stdin`, and `output`
 * shows each where a terminal echoes it, after its prompt. A lesson script
 * with a single pinned `result` is run on that result's `stdin` when no
 * `--stdin` is given, so running the script again reproduces its fixture.
 *
 * Exits 1 only when nothing could run: no files, no script to start from, or
 * an interpreter that did not start. A program that fails is a result.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import YAML from "yaml";

import type { PlaygroundFile } from "../src/runtime/playgroundContract.ts";
import {
  pickPythonRunEntry,
  PythonPlaygroundServiceError,
} from "../src/runtime/pythonPlayground/client.ts";
import {
  pythonRunResultToConsoleLines,
  pythonRunStartedConsoleLines,
} from "../src/runtime/pythonPlayground/console.ts";
import {
  bootPythonInterpreter,
  pythonTerminalOfLines,
} from "../src/runtime/pythonPlayground/interpreter.ts";

/** What a workspace never holds: tool folders and Python's own cache. */
const SKIPPED_FOLDERS = new Set(["__pycache__", "node_modules"]);

function filesUnder(folder: string): PlaygroundFile[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .filter(
      (path) => !path.split("/").some((part) => part.startsWith(".") || SKIPPED_FOLDERS.has(part)),
    )
    .map((path) => ({ path, content: readFileSync(join(folder, path), "utf8") }));
}

interface Workspace {
  files: PlaygroundFile[];
  /** The input a lesson script pins for its one result, where it pins any. */
  stdin?: string[];
}

/** The files a lesson script pins, before any of its typing, and its pinned input. */
function workspacePinnedBy(scriptPath: string): Workspace {
  const script = YAML.parse(readFileSync(scriptPath, "utf8")) as {
    lesson?: { workspace?: { files?: Record<string, string> } };
    runtime?: { fixture?: { result?: { stdin?: string[] } } };
  };
  return {
    files: Object.entries(script.lesson?.workspace?.files ?? {}).map(([path, content]) => ({
      path,
      content,
    })),
    stdin: script.runtime?.fixture?.result?.stdin,
  };
}

function workspaceOf(inputs: readonly string[]): Workspace {
  if (inputs.length === 1 && statSync(inputs[0]).isDirectory()) {
    return { files: filesUnder(inputs[0]) };
  }
  if (inputs.length === 1 && /\.ya?ml$/.test(inputs[0])) return workspacePinnedBy(inputs[0]);
  return {
    files: inputs.map((path) => ({ path: basename(path), content: readFileSync(path, "utf8") })),
  };
}

const USAGE =
  "usage: bun scripts/python-run.ts [--stdin <line>]... <folder | lesson.yaml | file.py ...>";

/** The command line: every `--stdin <line>` (or `--stdin=<line>`), and the paths left over. */
function parseArguments(args: readonly string[]): { inputs: string[]; stdin: string[] | null } {
  const inputs: string[] = [];
  const stdin: string[] = [];
  let hasStdin = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--stdin" || argument.startsWith("--stdin=")) {
      const line = argument === "--stdin" ? args[++index] : argument.slice("--stdin=".length);
      if (line === undefined) {
        console.error(`--stdin needs the line to type after it\n${USAGE}`);
        process.exit(1);
      }
      hasStdin = true;
      stdin.push(line);
    } else {
      inputs.push(argument);
    }
  }
  return { inputs, stdin: hasStdin ? stdin : null };
}

const { inputs, stdin: typedLines } = parseArguments(process.argv.slice(2));
if (inputs.length === 0) {
  console.error(USAGE);
  process.exit(1);
}

const workspace = workspaceOf(inputs);
// The dock's order: main.py first, then by path.
const files = workspace.files.sort((left, right) => left.path.localeCompare(right.path));
try {
  const entry = pickPythonRunEntry(files);
  const python = await bootPythonInterpreter();
  const result = await python.run(
    files,
    entry.path,
    pythonTerminalOfLines(typedLines ?? workspace.stdin ?? []),
  );

  console.log(YAML.stringify({ result }, { lineWidth: 0 }).trimEnd());
  console.log("\n# console");
  for (const line of [
    ...pythonRunStartedConsoleLines(files),
    ...pythonRunResultToConsoleLines(result),
  ]) {
    console.log(line);
  }
} catch (error) {
  console.error(
    error instanceof PythonPlaygroundServiceError
      ? error.message
      : `Python did not start: ${error}`,
  );
  process.exit(1);
}
