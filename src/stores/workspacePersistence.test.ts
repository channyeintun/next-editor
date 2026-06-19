import { describe, expect, it } from "vitest";
import {
  createWorkspaceStore,
  toPersistedSnapshot,
  type StoredWorkspaceSnapshot,
} from "./workspaceStore";
import { collectBinaryAssetPaths } from "../storage/workspaceAssetStore";
import {
  collectWorkspaceFolders,
  type WorkspaceFile,
  type WorkspaceProject,
} from "../types/workspace";

function makeFile(path: string, content: string, encoding?: "base64"): WorkspaceFile {
  return {
    path,
    name: path.split("/").pop() ?? path,
    language: "plaintext",
    content,
    ...(encoding ? { encoding } : {}),
  };
}

function makeProject(files: WorkspaceFile[]): WorkspaceProject {
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

describe("toPersistedSnapshot", () => {
  it("strips binary asset bytes but keeps metadata and text files", () => {
    const snapshot: StoredWorkspaceSnapshot = {
      activeFilePath: "index.html",
      project: makeProject([
        makeFile("index.html", "<html></html>"),
        makeFile("public/logo.png", "QUJD", "base64"),
      ]),
    };

    const persisted = toPersistedSnapshot(snapshot);

    expect(persisted.project.files["public/logo.png"].content).toBe("");
    expect(persisted.project.files["public/logo.png"].encoding).toBe("base64");
    expect(persisted.project.files["index.html"].content).toBe("<html></html>");
  });

  it("returns the same object when there is nothing binary to strip", () => {
    const snapshot: StoredWorkspaceSnapshot = {
      activeFilePath: "index.html",
      project: makeProject([makeFile("index.html", "<html></html>")]),
    };

    expect(toPersistedSnapshot(snapshot)).toBe(snapshot);
  });
});

describe("collectBinaryAssetPaths", () => {
  it("lists only base64-encoded files", () => {
    const project = makeProject([
      makeFile("index.html", "<html></html>"),
      makeFile("public/logo.png", "QUJD", "base64"),
      makeFile("assets/clip.mp4", "ZmFrZQ==", "base64"),
    ]);

    expect(collectBinaryAssetPaths(project).sort()).toEqual(["assets/clip.mp4", "public/logo.png"]);
  });
});

describe("hydrateAssetContents", () => {
  it("fills empty asset bytes without marking the workspace dirty", () => {
    const store = createWorkspaceStore({
      activeFilePath: "index.html",
      project: makeProject([
        makeFile("index.html", "<html></html>"),
        makeFile("public/logo.png", "", "base64"),
      ]),
    });

    expect(store.getSnapshot().context.dirtyState.hasUnsavedChanges).toBe(false);

    store.trigger.hydrateAssetContents({ contents: { "public/logo.png": "SGVsbG8=" } });

    const context = store.getSnapshot().context;
    expect(context.project.files["public/logo.png"].content).toBe("SGVsbG8=");
    expect(context.dirtyState.hasUnsavedChanges).toBe(false);
    expect(context.syncVersion).toBe(1);
    expect(context.previewVersion).toBe(1);
  });

  it("does not overwrite an asset that already has content", () => {
    const store = createWorkspaceStore({
      activeFilePath: "index.html",
      project: makeProject([
        makeFile("index.html", "<html></html>"),
        makeFile("public/logo.png", "QUJD", "base64"),
      ]),
    });

    store.trigger.hydrateAssetContents({ contents: { "public/logo.png": "ZZZZ" } });

    const context = store.getSnapshot().context;
    expect(context.project.files["public/logo.png"].content).toBe("QUJD");
    expect(context.syncVersion).toBe(0);
  });
});
