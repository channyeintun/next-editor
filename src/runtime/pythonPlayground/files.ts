import type { WorkspaceProject } from "../../types/workspace";
import {
  collectPlaygroundFiles,
  pickPlaygroundEntry,
  PLAYGROUND_SOURCE_RULES,
} from "../playgroundFiles";
import type { PythonPlaygroundFile } from "./types";

const PYTHON_SOURCES = PLAYGROUND_SOURCE_RULES.python;

/**
 * Matches every path, since any string ends with the empty one. The other
 * languages submit only their sources, but a Python program reads the files
 * beside it — `open("scores.csv")` is a first-week lesson — so a run is given
 * every text file of the workspace, whatever its extension.
 */
const EVERY_TEXT_FILE = [""];

/**
 * The workspace's current text files in deterministic order: `main.py` first,
 * because that is the file a run starts from, then the rest by path. Binary
 * assets are left out: a run reads files as the workspace holds them, as text.
 */
export function collectPythonPlaygroundFiles(
  project: Pick<WorkspaceProject, "files">,
): PythonPlaygroundFile[] {
  return collectPlaygroundFiles(project, {
    entryPath: PYTHON_SOURCES.entryPath,
    extensions: EVERY_TEXT_FILE,
  });
}

function isPythonSource(file: { path: string }): boolean {
  return PYTHON_SOURCES.extensions.some((extension) => file.path.endsWith(extension));
}

/**
 * The script a run starts from, chosen among the `.py` files only: `main.py`
 * wins, a single script is the program whatever its name, and otherwise there
 * is no way to tell — "empty" with no script at all, "ambiguous" with several
 * and none named `main.py`.
 */
export function findPythonRunEntry<File extends { path: string }>(
  files: readonly File[],
): File | "empty" | "ambiguous" {
  return pickPlaygroundEntry(files.filter(isPythonSource), PYTHON_SOURCES.entryPath);
}
