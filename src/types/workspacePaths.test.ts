import { describe, expect, it } from "vite-plus/test";
import { normalizeProject, WorkspaceProjectValidationError } from "../stores/workspaceStore";
import type { WorkspaceProject } from "./workspace";
import {
  collectWorkspaceFolders,
  getParentWorkspacePath,
  isReservedWorkspacePathSegment,
  isWorkspacePathControlCharacter,
  MAX_WORKSPACE_PATH_CHARS,
  MAX_WORKSPACE_PATH_DEPTH,
  normalizeWorkspacePath,
  parseWorkspacePath,
  tryParseWorkspacePath,
  WorkspacePathError,
  WorkspacePathLimitError,
} from "./workspacePaths";

function projectWithFiles(files: WorkspaceProject["files"]): WorkspaceProject {
  return {
    id: "paths",
    name: "Paths",
    lessonType: "html-css",
    entryFilePath: Object.keys(files)[0] ?? "index.html",
    folders: [],
    files,
  };
}

describe("workspace path canonicalization", () => {
  it("resolves contained dot segments and normalizes separators", () => {
    expect(parseWorkspacePath("/src\\features/./old/../App.tsx")).toBe("src/features/App.tsx");
  });

  it("rejects root traversal, control characters, and record-special names", () => {
    expect(() => parseWorkspacePath("../../outside.ts")).toThrow(WorkspacePathError);
    expect(() => parseWorkspacePath("src/\u0000secret.ts")).toThrow(WorkspacePathError);
    expect(() => parseWorkspacePath("src/__proto__/value.ts")).toThrow(WorkspacePathError);
    expect(() => parseWorkspacePath("src/App.tsx/")).toThrow(/empty terminal name/i);
    expect(normalizeWorkspacePath("../outside.ts")).toBe("");
    expect(normalizeWorkspacePath("src/App.tsx/")).toBe("");
  });

  // The collaboration projection renames a peer's node name with these, so a
  // name they pass must be one parseWorkspacePath accepts.
  it("exports name predicates that agree with the path parser", () => {
    const characters = Array.from({ length: 0xa1 }, (_, codePoint) =>
      String.fromCodePoint(codePoint),
    ).filter((character) => character !== "/" && character !== "\\");
    const controls = characters.filter((character) => isWorkspacePathControlCharacter(character));
    expect(controls).toEqual(
      characters.filter((character) => tryParseWorkspacePath(`a${character}b`) === null),
    );
    expect(controls).toHaveLength(33);

    const segments = ["__proto__", "prototype", "constructor", "proto", "Constructor"];
    const reserved = segments.filter((segment) => isReservedWorkspacePathSegment(segment));
    expect(reserved).toEqual(
      segments.filter((segment) => tryParseWorkspacePath(`src/${segment}`) === null),
    );
    expect(reserved).toEqual(["__proto__", "prototype", "constructor"]);
  });

  // Only three names were reserved, so "toString" or "valueOf" looked up an
  // inherited Object.prototype member in project.files and an agent write
  // stored a malformed file record under it.
  it("rejects every Object.prototype member name as a segment", () => {
    for (const path of ["toString", "a/valueOf", "hasOwnProperty", "__defineGetter__"]) {
      expect(() => parseWorkspacePath(path)).toThrow(WorkspacePathError);
    }
    expect(parseWorkspacePath("toString.ts")).toBe("toString.ts");
    expect(parseWorkspacePath("valueOf.js")).toBe("valueOf.js");
    expect(parseWorkspacePath("src/constructors")).toBe("src/constructors");
  });

  it("rebuilds canonical file metadata", () => {
    const project = normalizeProject(
      projectWithFiles({
        "src/old/../App.tsx": {
          path: "src/old/../App.tsx",
          name: "wrong-name",
          language: "wrong-language",
          content: "export default 1",
        },
      }),
    );

    expect(Object.keys(project.files)).toEqual(["src/App.tsx"]);
    expect(project.files["src/App.tsx"]).toMatchObject({
      path: "src/App.tsx",
      name: "App.tsx",
      language: "typescript",
    });
  });

  it("rejects canonical duplicates and file-directory conflicts", () => {
    expect(() =>
      normalizeProject(
        projectWithFiles({
          "src/App.tsx": {
            path: "src/App.tsx",
            name: "App.tsx",
            language: "typescript",
            content: "a",
          },
          "src/old/../App.tsx": {
            path: "src/old/../App.tsx",
            name: "App.tsx",
            language: "typescript",
            content: "b",
          },
        }),
      ),
    ).toThrow(WorkspaceProjectValidationError);

    expect(() =>
      normalizeProject(
        projectWithFiles({
          src: { path: "src", name: "src", language: "plaintext", content: "file" },
          "src/App.tsx": {
            path: "src/App.tsx",
            name: "App.tsx",
            language: "typescript",
            content: "nested",
          },
        }),
      ),
    ).toThrow(WorkspaceProjectValidationError);
  });
});

/** A path of `depth` segments, each `segment`. */
function pathOfDepth(depth: number, segment = "a"): string {
  return Array.from({ length: depth }, () => segment).join("/");
}

function fileAt(path: string): WorkspaceProject["files"] {
  return { [path]: { path, name: "f", language: "plaintext", content: "" } };
}

// Only the zip importer bounded a path, so one arriving any other way had no
// bound at all: a `.ne` file's workspace snapshot is loaded as soon as a lesson
// link opens, and `a/a/…/a/f` at depth 16,000 costs a few hundred deflated
// bytes there. The ancestor walks are quadratic in depth and keep every prefix,
// so that one path froze the tab for ~20 s per load and held 64 MB of folder
// names; a deeper one ran it out of memory.
describe("workspace path limits", () => {
  it("accepts a path at the depth and length limits", () => {
    const deepest = pathOfDepth(MAX_WORKSPACE_PATH_DEPTH);
    expect(parseWorkspacePath(deepest)).toBe(deepest);

    const longest = "a".repeat(MAX_WORKSPACE_PATH_CHARS);
    expect(parseWorkspacePath(longest)).toBe(longest);
  });

  it("rejects a path past the depth limit", () => {
    const tooDeep = pathOfDepth(MAX_WORKSPACE_PATH_DEPTH + 1);
    expect(() => parseWorkspacePath(tooDeep)).toThrow(WorkspacePathLimitError);
    expect(() => parseWorkspacePath(tooDeep)).toThrow(/nested deeper than 64 levels/);
    expect(tryParseWorkspacePath(tooDeep)).toBeNull();
    expect(normalizeWorkspacePath(tooDeep)).toBe("");
    expect(getParentWorkspacePath(tooDeep)).toBe("");
  });

  it("rejects a path past the length limit, and does not carry it in the error", () => {
    const tooLong = "a".repeat(MAX_WORKSPACE_PATH_CHARS + 1);
    expect(() => parseWorkspacePath(tooLong)).toThrow(/longer than 4096 characters/);

    let error: unknown;
    try {
      parseWorkspacePath(pathOfDepth(16_000));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorkspacePathLimitError);
    expect(error).toBeInstanceOf(WorkspacePathError);
    expect((error as WorkspacePathLimitError).input).toHaveLength(80);
    expect((error as WorkspacePathLimitError).message.length).toBeLessThan(100);
  });

  it("counts depth after dot segments are resolved", () => {
    const padded = `${pathOfDepth(40, ".")}/${pathOfDepth(40, "b/..")}/${pathOfDepth(64)}`;
    expect(parseWorkspacePath(padded)).toBe(pathOfDepth(64));
  });

  it("has a project refuse an over-deep or over-long path instead of walking it", () => {
    const startedAt = performance.now();
    for (const path of [
      `${pathOfDepth(15_999)}/f`,
      `${pathOfDepth(MAX_WORKSPACE_PATH_DEPTH)}/f`,
      `${"a".repeat(MAX_WORKSPACE_PATH_CHARS)}.ts`,
    ]) {
      expect(() => normalizeProject(projectWithFiles(fileAt(path)))).toThrow(
        WorkspaceProjectValidationError,
      );
      expect(() =>
        normalizeProject({ ...projectWithFiles(fileAt("index.html")), folders: [path] }),
      ).toThrow(WorkspaceProjectValidationError);
    }
    // Unbounded, the first path alone took ~20 s here; refusing it takes microseconds.
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it("still loads a project nested to the limit", () => {
    const path = `${pathOfDepth(MAX_WORKSPACE_PATH_DEPTH - 1)}/f.ts`;
    const project = normalizeProject(projectWithFiles(fileAt(path)));

    expect(Object.keys(project.files)).toEqual([path]);
    expect(project.folders).toHaveLength(MAX_WORKSPACE_PATH_DEPTH - 1);
    expect(project.folders.at(-1)).toBe(pathOfDepth(MAX_WORKSPACE_PATH_DEPTH - 1));
  });
});

describe("collectWorkspaceFolders", () => {
  it("collects every ancestor once, sorted, and skips unusable paths", () => {
    expect(
      collectWorkspaceFolders(
        ["src/a/b/one.ts", "src/a/b/two.ts", "src/c/three.ts", "root.ts", "../outside.ts"],
        ["docs/guide", "src/a", `${pathOfDepth(MAX_WORKSPACE_PATH_DEPTH + 1)}`],
      ),
    ).toEqual(["docs", "docs/guide", "src", "src/a", "src/a/b", "src/c"]);
  });

  it("walks a shared folder's ancestors once, however many files it holds", () => {
    const folder = pathOfDepth(MAX_WORKSPACE_PATH_DEPTH - 1, "d".repeat(60));
    const files = Array.from({ length: 5_000 }, (_, index) => `${folder}/${index}.ts`);

    const startedAt = performance.now();
    const folders = collectWorkspaceFolders(files);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(folders).toHaveLength(MAX_WORKSPACE_PATH_DEPTH - 1);
  });
});
