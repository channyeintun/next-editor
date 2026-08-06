import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { instantiateKiteCompiler, type KiteCompiler } from "../runtime/kitePlayground/compiler";
import {
  isWorkspaceTextFile,
  WORKSPACE_LESSON_TYPES,
  type WorkspaceProject,
} from "../types/workspace";
import { createStarterWorkspaceForLessonType } from "./index";

/**
 * Every `.kite` file in every starter compiles, and is already formatted.
 *
 * The console starter shipped for a while with `io.print("Squares: \(squares)")`
 * in it — a slice has no text form, so pressing Run answered with a build
 * error instead of output. It was the first thing a learner would have done.
 *
 * The check is generic rather than per-starter because the gap that allowed it
 * was specific: the web starter had a test that compiled its programs and the
 * console starter had none, so the one nobody thought to cover was the one
 * that broke. This covers whatever exists.
 */

const wasmPath = resolve(process.cwd(), "src/core/kite/build/kite-compiler.wasm");

/** Kite sources in a starter, keyed by module name — `checkout`, not `checkout.kite`. */
function kiteSources(project: WorkspaceProject): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const [path, file] of Object.entries(project.files)) {
    if (!path.endsWith(".kite") || !isWorkspaceTextFile(file)) continue;
    sources[path] = file.content;
  }
  return sources;
}

function moduleName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1, -".kite".length);
}

describe("kite starter programs", () => {
  let kite: KiteCompiler;
  const starters: Array<[string, WorkspaceProject]> = [];

  beforeAll(async () => {
    kite = await instantiateKiteCompiler(readFileSync(wasmPath));
    for (const lessonType of WORKSPACE_LESSON_TYPES) {
      const project = await createStarterWorkspaceForLessonType(lessonType);
      if (Object.keys(kiteSources(project)).length > 0) {
        starters.push([lessonType, project]);
      }
    }
  });

  it("finds the Kite starters", () => {
    expect(starters.map(([lessonType]) => lessonType).sort()).toEqual(["kite", "kite-web"]);
  });

  it("compiles every Kite file, with its siblings in scope", () => {
    for (const [lessonType, project] of starters) {
      const sources = kiteSources(project);
      for (const [path, content] of Object.entries(sources)) {
        // A Kite module is a directory, so every other `.kite` is in scope.
        const siblings: Record<string, string> = {};
        for (const [other, otherContent] of Object.entries(sources)) {
          if (other !== path) siblings[moduleName(other)] = otherContent;
        }
        expect(kite.checkModule(content, siblings), `${lessonType}: ${path} does not compile`).toBe(
          "",
        );
      }
    }
  });

  it("ships them already formatted, so Format moves nothing", () => {
    for (const [lessonType, project] of starters) {
      for (const [path, content] of Object.entries(kiteSources(project))) {
        expect(kite.format(content), `${lessonType}: ${path} is not formatted`).toBe(content);
      }
    }
  });

  it("runs the console starter's entry without a trap", () => {
    // The console starter is the one with output, and its whole purpose is
    // that pressing Run answers. Anything on stderr would show as a failure.
    const project = starters.find(([lessonType]) => lessonType === "kite")?.[1];
    expect(project).toBeDefined();
    const main = kiteSources(project!)["main.kite"];
    const output = kite.run(main);
    expect(output).not.toContain("error");
    expect(output.trim().length, "the starter printed nothing").toBeGreaterThan(0);
  });
});
