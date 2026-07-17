import { createWorkspaceStore, type StoredWorkspaceSnapshot } from "../../stores/workspaceStore";
import {
  collectWorkspaceFolders,
  type WorkspaceFile,
  type WorkspaceProject,
} from "../../types/workspace";
import type { ToolContext } from "../types";

/** Shared fixtures for the agent tool unit tests. */

export function makeFile(path: string, content: string): WorkspaceFile {
  return {
    path,
    name: path.split("/").pop() ?? path,
    language: "plaintext",
    content,
  };
}

export function makeAssetFile(path: string): WorkspaceFile {
  return {
    path,
    name: path.split("/").pop() ?? path,
    language: "binary",
    content: {
      kind: "asset",
      assetId: `asset-${path}`,
      mimeType: "application/octet-stream",
      size: 3,
    },
    encoding: "asset",
  };
}

export function makeProject(files: WorkspaceFile[]): WorkspaceProject {
  const fileMap = Object.fromEntries(files.map((file) => [file.path, file]));
  return {
    id: "test",
    name: "Test",
    lessonType: "html-css",
    entryFilePath: "index.html",
    folders: collectWorkspaceFolders(Object.keys(fileMap)),
    files: fileMap,
  };
}

export function makeStore(files: WorkspaceFile[]) {
  return createWorkspaceStore({
    activeFilePath: files[0]?.path ?? "index.html",
    project: makeProject(files),
  } as StoredWorkspaceSnapshot);
}

export function makeCtx(
  store: ReturnType<typeof makeStore>,
  signal = new AbortController().signal,
): ToolContext {
  return { workspace: store, signal, requestConfirmation: async () => true };
}
