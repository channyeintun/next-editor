import { describe, expect, it } from "vite-plus/test";
import { normalizeProject, WorkspaceProjectValidationError } from "../stores/workspaceStore";
import {
  normalizeWorkspacePath,
  parseWorkspacePath,
  WorkspacePathError,
  type WorkspaceProject,
} from "./workspace";

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
