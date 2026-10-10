import { describe, expect, it } from "vite-plus/test";
import {
  createDirtyState,
  EMPTY_WORKSPACE_DIRTY_STATE,
  hasUnsavedChanges,
  refreshDirtyPath,
} from "./workspaceDirtyState";
import type { WorkspaceFile, WorkspaceProject } from "../types/workspace";

function file(path: string, content: string): WorkspaceFile {
  return { path, name: path.split("/").pop() ?? path, language: "plaintext", content };
}

function project(files: WorkspaceFile[], overrides: Partial<WorkspaceProject> = {}) {
  return {
    id: "lesson",
    name: "Lesson",
    lessonType: "html-css",
    entryFilePath: "index.html",
    folders: [],
    files: Object.fromEntries(files.map((entry) => [entry.path, entry])),
    ...overrides,
  } satisfies WorkspaceProject;
}

describe("createDirtyState", () => {
  it("sorts and classifies added, modified and deleted paths", () => {
    const saved = project([file("index.html", "0"), file("b.css", ""), file("old.js", "")]);
    const current = project([file("index.html", "1"), file("b.css", ""), file("a.js", "")]);

    expect(createDirtyState(current, saved)).toEqual({
      dirtyFilePaths: ["a.js", "index.html", "old.js"],
      addedFilePaths: ["a.js"],
      modifiedFilePaths: ["index.html"],
      deletedFilePaths: ["old.js"],
      projectMetadataChanged: false,
      folderStructureChanged: false,
      hasUnsavedChanges: true,
    });
  });

  it("is clean for an unchanged project", () => {
    const saved = project([file("index.html", "0")]);
    expect(createDirtyState(project([file("index.html", "0")]), saved)).toEqual(
      EMPTY_WORKSPACE_DIRTY_STATE,
    );
  });

  it("flags metadata and folder changes with no file changes", () => {
    const saved = project([file("index.html", "0")]);

    expect(
      createDirtyState(project([file("index.html", "0")], { name: "Renamed" }), saved),
    ).toMatchObject({ projectMetadataChanged: true, hasUnsavedChanges: true });
    expect(
      createDirtyState(project([file("index.html", "0")], { folders: ["src"] }), saved),
    ).toMatchObject({ folderStructureChanged: true, hasUnsavedChanges: true });
  });
});

describe("refreshDirtyPath", () => {
  it("returns the same object when the path's membership is unchanged", () => {
    const saved = file("index.html", "0");
    const dirty = createDirtyState(project([saved]), project([saved]));

    expect(refreshDirtyPath(dirty, "index.html", { currentFile: saved, savedFile: saved })).toBe(
      dirty,
    );

    const modified = refreshDirtyPath(dirty, "index.html", {
      currentFile: file("index.html", "1"),
      savedFile: saved,
    });
    expect(
      refreshDirtyPath(modified, "index.html", {
        currentFile: file("index.html", "2"),
        savedFile: saved,
      }),
    ).toBe(modified);
  });

  it("updates membership for an added, a deleted and a modified path", () => {
    const dirty = {
      ...EMPTY_WORKSPACE_DIRTY_STATE,
      dirtyFilePaths: ["b.js"],
      addedFilePaths: ["b.js"],
    };

    const added = refreshDirtyPath(dirty, "a.js", { currentFile: file("a.js", "") });
    expect(added).toMatchObject({
      addedFilePaths: ["a.js", "b.js"],
      dirtyFilePaths: ["a.js", "b.js"],
      hasUnsavedChanges: true,
    });

    const deleted = refreshDirtyPath(dirty, "c.js", { savedFile: file("c.js", "") });
    expect(deleted).toMatchObject({
      deletedFilePaths: ["c.js"],
      dirtyFilePaths: ["b.js", "c.js"],
    });

    const modified = refreshDirtyPath(EMPTY_WORKSPACE_DIRTY_STATE, "index.html", {
      currentFile: file("index.html", "1"),
      savedFile: file("index.html", "0"),
    });
    expect(modified).toMatchObject({
      modifiedFilePaths: ["index.html"],
      dirtyFilePaths: ["index.html"],
      hasUnsavedChanges: true,
    });
  });

  it("clears hasUnsavedChanges when the last dirty path is reverted", () => {
    const saved = file("index.html", "0");
    const modified = refreshDirtyPath(EMPTY_WORKSPACE_DIRTY_STATE, "index.html", {
      currentFile: file("index.html", "1"),
      savedFile: saved,
    });

    expect(
      refreshDirtyPath(modified, "index.html", { currentFile: saved, savedFile: saved }),
    ).toEqual(EMPTY_WORKSPACE_DIRTY_STATE);
  });

  it("keeps metadata and folder changes unsaved after the files are reverted", () => {
    const saved = file("index.html", "0");
    const modified = refreshDirtyPath(
      { ...EMPTY_WORKSPACE_DIRTY_STATE, projectMetadataChanged: true, hasUnsavedChanges: true },
      "index.html",
      { currentFile: file("index.html", "1"), savedFile: saved },
    );

    expect(
      refreshDirtyPath(modified, "index.html", { currentFile: saved, savedFile: saved }),
    ).toMatchObject({ dirtyFilePaths: [], hasUnsavedChanges: true });
  });
});

describe("hasUnsavedChanges", () => {
  const clean = {
    dirtyFilePaths: [],
    projectMetadataChanged: false,
    folderStructureChanged: false,
  };

  it("is false when nothing changed", () => {
    expect(hasUnsavedChanges(clean)).toBe(false);
  });

  it("is true for each of the three reasons", () => {
    expect(hasUnsavedChanges({ ...clean, dirtyFilePaths: ["index.html"] })).toBe(true);
    expect(hasUnsavedChanges({ ...clean, projectMetadataChanged: true })).toBe(true);
    expect(hasUnsavedChanges({ ...clean, folderStructureChanged: true })).toBe(true);
  });
});
