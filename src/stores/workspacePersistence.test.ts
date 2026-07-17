/* oxlint-disable vitest/require-mock-type-parameters */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspaceStore,
  normalizeProject,
  toPersistedSnapshot,
  type StoredWorkspaceSnapshot,
} from "./workspaceStore";
import {
  collectBinaryAssetPaths,
  persistWorkspaceAssets,
  registerWorkspaceAsset,
  resetWorkspaceAssetStoreForTests,
  WorkspaceAssetPersistenceError,
} from "../storage/workspaceAssetStore";
import {
  collectWorkspaceFolders,
  isWorkspaceAssetFile,
  type WorkspaceAssetDescriptor,
  type WorkspaceFile,
  type WorkspaceProject,
} from "../types/workspace";

function makeFile(path: string, content: string, encoding?: "base64"): WorkspaceFile {
  const file = {
    path,
    name: path.split("/").pop() ?? path,
    language: "plaintext",
    content,
  };
  return encoding ? { ...file, encoding } : file;
}

function makeAssetFile(
  path: string,
  assetId = `asset-${path}`,
  size = 3,
): WorkspaceFile {
  return {
    path,
    name: path.split("/").pop() ?? path,
    language: "binary",
    content: {
      kind: "asset",
      assetId,
      mimeType: "application/octet-stream",
      size,
    },
    encoding: "asset",
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
  it("strips only legacy base64 while keeping descriptors and text", () => {
    const snapshot: StoredWorkspaceSnapshot = {
      activeFilePath: "index.html",
      project: makeProject([
        makeFile("index.html", "<html></html>"),
        makeFile("public/logo.png", "QUJD", "base64"),
        makeAssetFile("public/current.png"),
      ]),
    };

    const persisted = toPersistedSnapshot(snapshot);

    expect(persisted.project.files["public/logo.png"].content).toBe("");
    expect(persisted.project.files["public/logo.png"].encoding).toBe("base64");
    expect(persisted.project.files["public/current.png"]).toEqual(
      snapshot.project.files["public/current.png"],
    );
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
  it("lists descriptor and legacy binary files", () => {
    const project = makeProject([
      makeFile("index.html", "<html></html>"),
      makeFile("public/logo.png", "QUJD", "base64"),
      makeAssetFile("assets/clip.mp4"),
    ]);

    expect(collectBinaryAssetPaths(project).sort()).toEqual(["assets/clip.mp4", "public/logo.png"]);
  });
});

describe("hydrateAssetDescriptors", () => {
  it("migrates legacy entries without marking the workspace dirty", () => {
    const store = createWorkspaceStore({
      activeFilePath: "index.html",
      project: makeProject([
        makeFile("index.html", "<html></html>"),
        makeFile("public/logo.png", "", "base64"),
      ]),
    });

    const initial = store.getSnapshot().context;
    expect(initial.isInitialized && initial.dirtyState.hasUnsavedChanges).toBe(false);

    const descriptor: WorkspaceAssetDescriptor = {
      kind: "asset",
      assetId: "asset-logo",
      mimeType: "image/png",
      size: 5,
    };
    store.trigger.hydrateAssetDescriptors({
      descriptors: { "public/logo.png": descriptor },
    });

    const context = store.getSnapshot().context;
    if (!context.isInitialized) throw new Error("Expected initialized");
    expect(context.project.files["public/logo.png"].content).toEqual(descriptor);
    expect(context.project.files["public/logo.png"].encoding).toBe("asset");
    expect(context.dirtyState.hasUnsavedChanges).toBe(false);
    expect(context.syncVersion).toBe(1);
    expect(context.previewVersion).toBe(1);
  });

  it("does not overwrite an existing descriptor", () => {
    const store = createWorkspaceStore({
      activeFilePath: "index.html",
      project: makeProject([
        makeFile("index.html", "<html></html>"),
        makeAssetFile("public/logo.png", "asset-original"),
      ]),
    });

    store.trigger.hydrateAssetDescriptors({
      descriptors: {
        "public/logo.png": {
          kind: "asset",
          assetId: "asset-other",
          mimeType: "image/png",
          size: 4,
        },
      },
    });

    const context = store.getSnapshot().context;
    if (!context.isInitialized) throw new Error("Expected initialized");
    expect(isWorkspaceAssetFile(context.project.files["public/logo.png"])).toBe(true);
    expect(context.project.files["public/logo.png"].content).toMatchObject({
      assetId: "asset-original",
    });
    expect(context.syncVersion).toBe(0);
  });
});

describe("workspace dirty state", () => {
  it("applies validated incremental text edits and rejects stale events", () => {
    const before = "<html></html>";
    const after = "<html>fast</html>";
    const store = createWorkspaceStore({
      activeFilePath: "index.html",
      project: makeProject([makeFile("index.html", before)]),
    });

    store.trigger.applyFileTextEdits({
      fileId: "index.html",
      path: "index.html",
      beforeVersion: 1,
      afterVersion: 2,
      beforeLength: before.length,
      afterLength: after.length,
      changes: [{ offset: 6, deleteLength: 0, text: "fast" }],
    });

    let context = store.getSnapshot().context;
    if (!context.isInitialized) throw new Error("Expected initialized");
    expect(context.project.files["index.html"].content).toBe(after);
    expect(context.dirtyState.modifiedFilePaths).toEqual(["index.html"]);

    store.trigger.applyFileTextEdits({
      fileId: "index.html",
      path: "index.html",
      beforeVersion: 2,
      afterVersion: 3,
      beforeLength: before.length,
      afterLength: before.length + 1,
      changes: [{ offset: 0, deleteLength: 0, text: "!" }],
    });
    context = store.getSnapshot().context;
    if (!context.isInitialized) throw new Error("Expected initialized");
    expect(context.project.files["index.html"].content).toBe(after);
  });

  it("tracks deleted files and returns to clean after an exact revert", () => {
    const store = createWorkspaceStore({
      activeFilePath: "index.html",
      project: makeProject([
        makeFile("index.html", "<html></html>"),
        makeFile("notes.txt", "keep me"),
      ]),
    });

    store.trigger.deleteFile({ path: "notes.txt" });
    let context = store.getSnapshot().context;
    if (!context.isInitialized) throw new Error("Expected initialized");
    expect(context.dirtyState.deletedFilePaths).toEqual(["notes.txt"]);
    expect(context.dirtyState.hasUnsavedChanges).toBe(true);

    store.trigger.createFile({ path: "notes.txt", content: "keep me" });
    context = store.getSnapshot().context;
    if (!context.isInitialized) throw new Error("Expected initialized");
    expect(context.dirtyState).toMatchObject({
      addedFilePaths: [],
      modifiedFilePaths: [],
      deletedFilePaths: [],
      hasUnsavedChanges: false,
    });
  });

  it("tracks renames, empty folders, lesson type, and entry path", () => {
    const store = createWorkspaceStore({
      activeFilePath: "index.html",
      project: makeProject([
        makeFile("index.html", "<html></html>"),
        makeFile("other.html", "other"),
      ]),
    });

    store.trigger.renameFile({ currentPath: "other.html", nextPath: "renamed.html" });
    store.trigger.createFolder({ path: "empty" });
    store.trigger.updateLessonType({ lessonType: "react" });
    store.trigger.setPreviewFilePath({ path: "renamed.html" });

    const context = store.getSnapshot().context;
    if (!context.isInitialized) throw new Error("Expected initialized");
    expect(context.dirtyState.addedFilePaths).toEqual(["renamed.html"]);
    expect(context.dirtyState.deletedFilePaths).toEqual(["other.html"]);
    expect(context.dirtyState.folderStructureChanged).toBe(true);
    expect(context.dirtyState.projectMetadataChanged).toBe(true);
  });

  it("tracks encoding-only changes and returns to clean after a structural round trip", () => {
    const original = makeProject([
      makeFile("index.html", "same bytes"),
      makeFile("asset.bin", "QUJD", "base64"),
    ]);
    const store = createWorkspaceStore({ activeFilePath: "index.html", project: original });
    const encodingChanged = makeProject([
      makeFile("index.html", "same bytes"),
      makeFile("asset.bin", "QUJD"),
    ]);

    store.trigger.reconcileExternalProject({ project: encodingChanged });
    let context = store.getSnapshot().context;
    if (!context.isInitialized) throw new Error("Expected initialized");
    expect(context.dirtyState.modifiedFilePaths).toEqual(["asset.bin"]);
    expect(context.dirtyState.hasUnsavedChanges).toBe(true);

    store.trigger.reconcileExternalProject({ project: original });
    context = store.getSnapshot().context;
    if (!context.isInitialized) throw new Error("Expected initialized");
    expect(context.dirtyState).toMatchObject({
      dirtyFilePaths: [],
      projectMetadataChanged: false,
      folderStructureChanged: false,
      hasUnsavedChanges: false,
    });
  });

  it("atomically reconciles runtime changes without replacing the saved baseline", () => {
    const original = makeProject([
      makeFile("index.html", "original"),
      makeFile("old.txt", "remove"),
    ]);
    const store = createWorkspaceStore({ activeFilePath: "old.txt", project: original });
    const runtimeProject = makeProject([
      makeFile("index.html", "runtime edit"),
      makeFile("new.txt", "created"),
    ]);

    store.trigger.reconcileExternalProject({ project: runtimeProject });

    const context = store.getSnapshot().context;
    if (!context.isInitialized) throw new Error("Expected initialized");
    expect(Object.keys(context.project.files).sort()).toEqual(["index.html", "new.txt"]);
    expect(context.project.files["index.html"].content).toBe("runtime edit");
    expect(context.savedSnapshot.project).toEqual(normalizeProject(original));
    expect(context.activeFilePath).toBe("index.html");
    expect(context.dirtyState.modifiedFilePaths).toEqual(["index.html"]);
    expect(context.dirtyState.addedFilePaths).toEqual(["new.txt"]);
    expect(context.dirtyState.deletedFilePaths).toEqual(["old.txt"]);
    expect(context.dirtyState.hasUnsavedChanges).toBe(true);
  });

  it("rejects new file and folder paths that cross an existing file boundary", () => {
    const store = createWorkspaceStore({
      activeFilePath: "index.html",
      project: makeProject([makeFile("index.html", "root"), makeFile("src", "file")]),
    });

    store.trigger.createFile({ path: "src/App.tsx", content: "nested" });
    store.trigger.createFolder({ path: "src/components" });

    const context = store.getSnapshot().context;
    if (!context.isInitialized) throw new Error("Expected initialized");
    expect(context.project.files["src/App.tsx"]).toBeUndefined();
    expect(context.project.folders).not.toContain("src/components");
    expect(context.dirtyState.hasUnsavedChanges).toBe(false);
  });
});

describe("persistWorkspaceAssets", () => {
  afterEach(() => {
    resetWorkspaceAssetStoreForTests();
    vi.unstubAllGlobals();
  });

  it("rejects when binary assets cannot be persisted", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const project = makeProject([makeAssetFile("public/logo.png")]);

    await expect(persistWorkspaceAssets(project)).rejects.toBeInstanceOf(
      WorkspaceAssetPersistenceError,
    );
  });

  it("rejects an IndexedDB open failure", async () => {
    const failure = new Error("open failed");
    const factory = {
      open: vi.fn(() => {
        const request: Partial<IDBOpenDBRequest> = { error: failure as DOMException };
        queueMicrotask(() => request.onerror?.(new Event("error")));
        return request as IDBOpenDBRequest;
      }),
    } as unknown as IDBFactory;
    vi.stubGlobal("indexedDB", factory);

    await expect(
      persistWorkspaceAssets(makeProject([makeAssetFile("asset.bin")])),
    ).rejects.toMatchObject({ name: "WorkspaceAssetPersistenceError", cause: failure });
  });

  it("rejects a quota/transaction abort", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const descriptor = await registerWorkspaceAsset(new Uint8Array([65, 66, 67]), {
      mimeType: "application/octet-stream",
    });
    const quotaError = new DOMException("quota exhausted", "QuotaExceededError");
    const transaction = {
      error: null as DOMException | null,
      objectStore: vi.fn(() => ({
        put: vi.fn(() => {
          queueMicrotask(() => {
            transaction.error = quotaError;
            transaction.onabort?.(new Event("abort"));
          });
        }),
      })),
      oncomplete: null as ((event: Event) => void) | null,
      onerror: null as ((event: Event) => void) | null,
      onabort: null as ((event: Event) => void) | null,
    };
    const database = {
      objectStoreNames: { contains: () => true },
      transaction: vi.fn(() => transaction as unknown as IDBTransaction),
      close: vi.fn(),
      onversionchange: null,
    } as unknown as IDBDatabase;
    const factory = {
      open: vi.fn(() => {
        const request: Partial<IDBOpenDBRequest> = { result: database };
        queueMicrotask(() => request.onsuccess?.(new Event("success")));
        return request as IDBOpenDBRequest;
      }),
    } as unknown as IDBFactory;
    vi.stubGlobal("indexedDB", factory);

    await expect(
      persistWorkspaceAssets(
        makeProject([
          {
            path: "asset.bin",
            name: "asset.bin",
            language: "binary",
            content: descriptor,
            encoding: "asset",
          },
        ]),
      ),
    ).rejects.toMatchObject({ name: "WorkspaceAssetPersistenceError", cause: quotaError });
  });
});
