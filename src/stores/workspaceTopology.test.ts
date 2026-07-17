import { describe, expect, it } from "vite-plus/test";
import { createWorkspaceStore } from "./workspaceStore";
import type { WorkspaceProject, WorkspaceTextFile } from "../types/workspace";

function file(path: string, content: string): WorkspaceTextFile {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    language: "typescript",
    content,
  };
}

function project(): WorkspaceProject {
  return {
    id: "topology",
    name: "Topology",
    lessonType: "react",
    entryFilePath: "src/a.ts",
    folders: ["src"],
    files: {
      "src/a.ts": file("src/a.ts", "export const a = 1;"),
      "src/b.ts": file("src/b.ts", "export const b = 1;"),
    },
  };
}

function initialized(store: ReturnType<typeof createWorkspaceStore>) {
  const context = store.getSnapshot().context;
  if (!context.isInitialized) throw new Error("Expected initialized workspace");
  return context;
}

describe("workspace tree topology", () => {
  it("keeps content out of stable sidebar metadata", () => {
    const store = createWorkspaceStore({ activeFilePath: "src/a.ts", project: project() });
    const initial = initialized(store);
    const initialSidebar = initial.sidebarState;
    const initialTreeFiles = initialSidebar.files;
    expect(initialTreeFiles.every((entry) => !("content" in entry))).toBe(true);

    store.trigger.updateFileContent({ path: "src/a.ts", content: "export const a = 2;" });
    let context = initialized(store);
    expect(context.treeVersion).toBe(0);
    expect(context.sidebarState).toBe(initialSidebar);

    store.trigger.setActiveFilePath({ path: "src/b.ts" });
    context = initialized(store);
    expect(context.treeVersion).toBe(0);
    expect(context.sidebarState.files).toBe(initialTreeFiles);
  });

  it("increments treeVersion only when file or folder topology changes", () => {
    const store = createWorkspaceStore({ activeFilePath: "src/a.ts", project: project() });

    store.trigger.updateLessonType({ lessonType: "solid" });
    expect(initialized(store).treeVersion).toBe(0);

    const contentOnly = initialized(store).project;
    store.trigger.reconcileExternalProject({
      project: {
        ...contentOnly,
        files: {
          ...contentOnly.files,
          "src/a.ts": file("src/a.ts", "changed remotely"),
        },
      },
    });
    expect(initialized(store).treeVersion).toBe(0);

    store.trigger.createFolder({ path: "examples" });
    expect(initialized(store).treeVersion).toBe(1);
    store.trigger.createFile({ path: "examples/demo.ts", content: "demo" });
    expect(initialized(store).treeVersion).toBe(2);
    store.trigger.renameFile({ currentPath: "examples/demo.ts", nextPath: "examples/main.ts" });
    expect(initialized(store).treeVersion).toBe(3);
    store.trigger.deleteFolder({ path: "examples" });
    expect(initialized(store).treeVersion).toBe(4);
  });

  it("refreshes only the changed path's editor and dirty state", () => {
    const store = createWorkspaceStore({ activeFilePath: "src/a.ts", project: project() });
    const initial = initialized(store);
    const initialSidebar = initial.sidebarState;
    let unrelatedContentReads = 0;
    const unrelatedFile = initial.project.files["src/b.ts"];
    const unrelatedContent = unrelatedFile.content;
    Object.defineProperty(unrelatedFile, "content", {
      configurable: true,
      enumerable: true,
      get: () => {
        unrelatedContentReads += 1;
        return unrelatedContent;
      },
    });

    store.trigger.updateFileContent({ path: "src/a.ts", content: "export const a = 2;" });
    let context = initialized(store);
    expect(context.editorState).not.toBe(initial.editorState);
    expect(context.sidebarState).toBe(initialSidebar);
    expect(context.dirtyState).toMatchObject({
      dirtyFilePaths: ["src/a.ts"],
      modifiedFilePaths: ["src/a.ts"],
      addedFilePaths: [],
      deletedFilePaths: [],
      hasUnsavedChanges: true,
    });
    expect(unrelatedContentReads).toBe(0);

    store.trigger.setActiveFilePath({ path: "src/b.ts" });
    context = initialized(store);
    const inactiveEditorState = context.editorState;
    const readsAfterFileSwitch = unrelatedContentReads;
    store.trigger.updateFileContent({ path: "src/a.ts", content: "export const a = 3;" });
    context = initialized(store);
    expect(context.editorState).toBe(inactiveEditorState);
    expect(unrelatedContentReads).toBe(readsAfterFileSwitch);

    store.trigger.updateFileContent({ path: "src/a.ts", content: "export const a = 1;" });
    context = initialized(store);
    expect(context.dirtyState.modifiedFilePaths).toEqual([]);
    expect(context.dirtyState.hasUnsavedChanges).toBe(false);
  });
});
