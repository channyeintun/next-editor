/**
 * Where the lesson scripts are on this machine. Every tool, test and dev
 * plugin that reads a LessonScript YAML from disk finds the folder here, so
 * moving the scripts (to another folder, or to a checkout of their own) is
 * `LESSONS_DIR` and nothing else.
 *
 * Node only. The app must never import it: the app does not read scripts from
 * disk, and a bundler would turn the URL below into an asset reference. App
 * code that only needs to name the folder uses `LESSON_SCRIPTS_FOLDER`.
 */

import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LESSON_SCRIPTS_FOLDER } from "../src/studio/plans/publishedScripts.ts";

// Not `new URL("..", import.meta.url)`: in the tests' browser-like transform,
// Vite rewrites that pattern into an asset URL that is not a file URL.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The folder, absolute. `LESSONS_DIR` replaces it; a relative value is read from the repository's root, never from the working directory. */
export function lessonScriptsDir(): string {
  const override = process.env.LESSONS_DIR;
  return override ? resolve(REPO_ROOT, override) : join(REPO_ROOT, LESSON_SCRIPTS_FOLDER);
}

export function lessonScriptPath(slug: string): string {
  return join(lessonScriptsDir(), `${slug}.yaml`);
}

/** The Director's advisory notes for a script, kept beside it. */
export function lessonCritiquePath(slug: string): string {
  return join(lessonScriptsDir(), `${slug}.critique.json`);
}

/**
 * The slug of every script in the folder, in the order of the file names. A
 * script's slug is its file name. File-name order, not slug order ("a-b.yaml"
 * sorts before "a.yaml"), is the order the tools have always listed lessons
 * in, and what webnode-deps names a shared manifest after.
 */
export function lessonScriptSlugs(): string[] {
  return readdirSync(lessonScriptsDir())
    .filter((name) => name.endsWith(".yaml"))
    .sort()
    .map((name) => name.slice(0, -".yaml".length));
}
