/**
 * Python run — the fixture `result` of a Python lesson, from the real
 * interpreter (docs/lesson-script-authoring.md, "Lesson types and runtime
 * kinds").
 *
 *   bun scripts/python-run.ts <folder>                       every file under the folder
 *   bun scripts/python-run.ts main.py helpers.py scores.csv  these files, by name
 *   bun scripts/python-run.ts src/studio/scripts/<slug>.yaml the script's pinned workspace
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
import { bootPythonInterpreter } from "../src/runtime/pythonPlayground/interpreter.ts";

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

/** The files a lesson script pins, before any of its typing. */
function filesPinnedBy(scriptPath: string): PlaygroundFile[] {
  const script = YAML.parse(readFileSync(scriptPath, "utf8")) as {
    lesson?: { workspace?: { files?: Record<string, string> } };
  };
  return Object.entries(script.lesson?.workspace?.files ?? {}).map(([path, content]) => ({
    path,
    content,
  }));
}

function workspaceFiles(inputs: readonly string[]): PlaygroundFile[] {
  if (inputs.length === 1 && statSync(inputs[0]).isDirectory()) return filesUnder(inputs[0]);
  if (inputs.length === 1 && /\.ya?ml$/.test(inputs[0])) return filesPinnedBy(inputs[0]);
  return inputs.map((path) => ({ path: basename(path), content: readFileSync(path, "utf8") }));
}

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  console.error("usage: bun scripts/python-run.ts <folder | lesson.yaml | file.py ...>");
  process.exit(1);
}

// The dock's order: main.py first, then by path.
const files = workspaceFiles(inputs).sort((left, right) => left.path.localeCompare(right.path));
try {
  const entry = pickPythonRunEntry(files);
  const python = await bootPythonInterpreter();
  const result = await python.run(files, entry.path);

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
