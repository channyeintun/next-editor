// The workspaces webnode is asked to install and run: every runtime lesson's
// (a studio script whose runtime is webnode's) and every starter's. The
// measurements (measure.ts) and the prepared installs (scripts/webnode-deps.ts)
// both start from this one listing.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { lessonScriptPath, lessonScriptSlugs } from "../lessonScriptsDir";
import { STARTERS, STARTERS_ROOT } from "./starters";
import type { Shows } from "./starters";

/** The parts of a studio lesson script the scenarios read. */
export interface LessonScript {
  lesson: { workspace: { files: Record<string, string> } };
  runtime?: {
    kind?: string;
    initCommand?: string;
    runCommand?: string;
    expectedPort?: number;
    environment?: Record<string, string>;
  };
  scenes?: { actions?: LessonAction[] }[];
}

export interface LessonAction {
  type: string;
  target?: { file: string; after: string; occurrence?: number };
  text?: string;
}

/** Every runtime lesson by slug, in the order of the scripts' file names. */
export function runtimeLessons(): Map<string, LessonScript> {
  const scripts = new Map<string, LessonScript>();
  for (const slug of lessonScriptSlugs()) {
    const script = parse(readFileSync(lessonScriptPath(slug), "utf8")) as LessonScript;
    if (script.runtime?.kind !== "webcontainer") {
      continue;
    }
    scripts.set(slug, script);
  }
  return scripts;
}

/** A starter's workspace: its text files, and what `pnpm dev` leads to. */
export interface StarterWorkspace {
  name: string;
  files: Record<string, string>;
  shows: Shows;
}

/** Every starter's workspace, in the order STARTERS lists them. */
export async function starterWorkspaces(): Promise<StarterWorkspace[]> {
  const workspaces: StarterWorkspace[] = [];
  for (const [name, starter] of Object.entries(STARTERS)) {
    const project = (await import(STARTERS_ROOT + starter.file))[starter.factory]();
    const files: Record<string, string> = {};
    for (const [path, file] of Object.entries(
      project.files as Record<string, { content?: string }>,
    )) {
      if (typeof file.content === "string") {
        files[path] = file.content;
      }
    }
    workspaces.push({ name, files, shows: starter.shows });
  }
  return workspaces;
}
