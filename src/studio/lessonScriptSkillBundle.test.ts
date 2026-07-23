import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";
import { buildBundle } from "../../scripts/build-lesson-script-skill";
import { parseLessonScript } from "./script/schema";
import {
  RUNTIME_KIND_FOR_LESSON,
  studioPlanActionSchema,
  type StudioLessonType,
  type StudioRuntimeKind,
} from "./plan";

/**
 * The distributed `share/lesson-script-skill/` bundle is a self-contained
 * contract external agents follow without the repo. This test is the anti-fork
 * guard the review (SKILL-01) asked for: it proves every advertised lesson type
 * is authorable, that the reference's runtime matrix and action catalog are
 * derived from the schema, and that the checked-in bundle equals the generator's
 * output (so no one hand-edits it back into a stale fork).
 */

const ROOT = resolve(__dirname, "../..");
const readBundle = (relative: string) =>
  readFileSync(resolve(ROOT, "share/lesson-script-skill", relative), "utf8");
const reference = readBundle("references/lesson-script-authoring.md");

/** The action types agents author. cursor.moveTo is derived by the compiler, not authored. */
const schemaActionTypes = studioPlanActionSchema.options.map(
  (option) => option.shape.type.value as string,
);
const authoredActionTypes = schemaActionTypes.filter((type) => type !== "cursor.moveTo").sort();

/** A minimal, schema-valid script for each advertised lesson type. */
function minimalScript(lessonType: StudioLessonType): unknown {
  const base = {
    schemaVersion: 1 as const,
    build: { voiceProfile: "pocket-alba-v1", seed: 1 },
    scenes: [{ id: "s", narration: "Here is one small idea worth knowing." }],
  };
  const workspace = (files: Record<string, string>, entryFilePath: string) => ({
    lessonType,
    name: "T",
    entryFilePath,
    files,
  });

  switch (lessonType) {
    case "go":
      return {
        ...base,
        lesson: {
          slug: "t-go",
          title: "T",
          locale: "en-US",
          workspace: workspace({ "main.go": "package main\nfunc main() {}\n" }, "main.go"),
        },
        runtime: {
          kind: "go-playground",
          defaultMode: "fixture",
          fixture: { latencyMs: 10, result: { status: "success", output: "", exitCode: 0 } },
        },
      };
    case "kotlin":
      return {
        ...base,
        lesson: {
          slug: "t-kotlin",
          title: "T",
          locale: "en-US",
          workspace: workspace({ "Main.kt": "fun main() {}\n" }, "Main.kt"),
        },
        runtime: {
          kind: "kotlin-playground",
          defaultMode: "fixture",
          fixture: { latencyMs: 10, result: { status: "success", output: "" } },
        },
      };
    case "rust":
      return {
        ...base,
        lesson: {
          slug: "t-rust",
          title: "T",
          locale: "en-US",
          workspace: workspace({ "main.rs": "fn main() {}\n" }, "main.rs"),
        },
        runtime: {
          kind: "rust-playground",
          defaultMode: "fixture",
          fixture: { latencyMs: 10, result: { status: "success", stdout: "", stderr: "" } },
        },
      };
    case "javascript":
      return {
        ...base,
        lesson: {
          slug: "t-js",
          title: "T",
          locale: "en-US",
          workspace: workspace(
            { "package.json": "{}", "package-lock.json": "{}", "index.js": "console.log(1);\n" },
            "index.js",
          ),
        },
        runtime: {
          kind: "webcontainer",
          adapterVersion: 1,
          defaultMode: "live",
          initCommand: "npm ci",
          runCommand: "npm start",
          lockfilePath: "package-lock.json",
          environment: {},
        },
      };
    case "typescript":
      return {
        ...base,
        lesson: {
          slug: "t-ts",
          title: "T",
          locale: "en-US",
          workspace: workspace(
            { "package.json": "{}", "package-lock.json": "{}", "src/main.ts": "export {};\n" },
            "src/main.ts",
          ),
        },
        runtime: {
          kind: "webcontainer",
          adapterVersion: 1,
          defaultMode: "live",
          initCommand: "npm ci",
          runCommand: "npm run dev",
          lockfilePath: "package-lock.json",
          environment: {},
        },
      };
    case "python":
      // WebContainer WASI python3: no lockfile, no dev server, console output.
      return {
        ...base,
        lesson: {
          slug: "t-py",
          title: "T",
          locale: "en-US",
          workspace: workspace({ "main.py": "print('hi')\n" }, "main.py"),
        },
        runtime: {
          kind: "webcontainer",
          adapterVersion: 1,
          defaultMode: "live",
          initCommand: "",
          runCommand: "python3 main.py",
          environment: {},
        },
      };
  }
}

/** Parse the "Lesson types and runtime kinds" markdown table into lessonType → kind. */
function parseRuntimeMatrix(markdown: string): Record<string, string> {
  const heading = "### Lesson types and runtime kinds";
  const start = markdown.indexOf(heading);
  const section = markdown.slice(start, markdown.indexOf("\n### ", start + heading.length));
  const matrix: Record<string, string> = {};
  for (const line of section.split("\n")) {
    const row = line.match(/^\|\s*(.+?)\s*\|\s*`([^`]+)`\s*\|/);
    if (!row || row[1].includes("lessonType") || row[1].includes("---")) continue;
    for (const cell of row[1].split(",")) {
      const type = cell.trim().replace(/`/g, "");
      if (type) matrix[type] = row[2];
    }
  }
  return matrix;
}

/** Action type names (`x.y`) documented in the "Action catalog" table's first column. */
function parseActionCatalog(markdown: string): string[] {
  const heading = "Action catalog:";
  const start = markdown.indexOf(heading);
  const section = markdown.slice(start, markdown.indexOf("\n### ", start));
  const types = new Set<string>();
  for (const line of section.split("\n")) {
    const cell = line.match(/^\|\s*`([a-z]+\.[a-zA-Z]+)`\s*\|/);
    if (cell) types.add(cell[1]);
  }
  return [...types].sort();
}

describe("lesson-script skill bundle contract (SKILL-01)", () => {
  it("parses one minimal example per advertised lesson type", () => {
    const lessonTypes = Object.keys(RUNTIME_KIND_FOR_LESSON) as StudioLessonType[];
    const failed = lessonTypes.filter((lessonType) => {
      try {
        parseLessonScript(minimalScript(lessonType));
        return false;
      } catch {
        return true;
      }
    });
    expect(failed).toEqual([]);
  });

  it("parses the bundled rust-borrow.yaml example", () => {
    const yaml = YAML.parse(readBundle("examples/rust-borrow.yaml"));
    expect(() => parseLessonScript(yaml)).not.toThrow();
  });

  it("documents a runtime matrix derived from the schema, not a fork", () => {
    const expected: Record<string, StudioRuntimeKind> = {};
    for (const [lessonType, kind] of Object.entries(RUNTIME_KIND_FOR_LESSON)) {
      expected[lessonType] = kind;
    }
    expect(parseRuntimeMatrix(reference)).toEqual(expected);
    // JS/TS/Python all run in the WebContainer (Python on WASI python3); the
    // fork's regression was labelling JS/TS `none`.
    expect(RUNTIME_KIND_FOR_LESSON.javascript).toBe("webcontainer");
    expect(RUNTIME_KIND_FOR_LESSON.typescript).toBe("webcontainer");
    expect(RUNTIME_KIND_FOR_LESSON.python).toBe("webcontainer");
  });

  it("documents exactly the authored action types from the schema", () => {
    // Set equality both ways: every documented action is real, and every authored
    // action — including the WebContainer/preview ones the fork dropped — is documented.
    expect(parseActionCatalog(reference)).toEqual(authoredActionTypes);
    for (const required of [
      "runtime.start",
      "runtime.waitForReady",
      "preview.open",
      "expect.preview",
    ]) {
      expect(authoredActionTypes).toContain(required);
    }
  });

  it("does not claim import verifies Google deck page ids (it resolves at render)", () => {
    expect(reference).not.toMatch(/import step verifies the page ids/);
    expect(reference).toMatch(/resolve during the render build/);
  });

  it("matches the generator output — the bundle is regenerated, not hand-forked", () => {
    const stale = buildBundle()
      .filter((artifact) => readFileSync(resolve(ROOT, artifact.path), "utf8") !== artifact.content)
      .map((artifact) => artifact.path);
    // Stale entries mean: run bun scripts/build-lesson-script-skill.ts
    expect(stale).toEqual([]);
  });
});
