import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceSyncMutation } from "../contexts/WorkspaceContext";
import type { WorkspaceAssetDescriptor, WorkspaceProject } from "../types/workspace";

const assets = vi.hoisted(() => ({
  persist: vi.fn<(project: WorkspaceProject) => Promise<void>>(),
  prune: vi.fn<() => Promise<void>>(),
  migrate: vi.fn<
    (
      project: WorkspaceProject,
      generation?: string,
    ) => Promise<Record<string, WorkspaceAssetDescriptor>>
  >(async () => ({})),
}));

vi.mock("../storage/workspaceAssetStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage/workspaceAssetStore")>();
  return {
    ...actual,
    migrateLegacyWorkspaceAssets: assets.migrate,
    persistWorkspaceAssets: assets.persist,
    pruneLegacyWorkspaceAssetKeys: assets.prune,
  };
});

const { createWorkspaceActions } = await import("./workspaceActions");
const { WORKSPACE_STORAGE_KEY, createWorkspaceStore } = await import("./workspaceStore");

function lesson(): WorkspaceProject {
  return {
    id: "lesson",
    name: "Lesson",
    lessonType: "html-css",
    entryFilePath: "index.html",
    folders: [],
    files: {
      "index.html": { path: "index.html", name: "index.html", language: "html", content: "0" },
      "style.css": { path: "style.css", name: "style.css", language: "css", content: "" },
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function isDirty(store: ReturnType<typeof createWorkspaceStore>): boolean {
  const context = store.getSnapshot().context;
  return context.isInitialized && context.dirtyState.hasUnsavedChanges;
}

describe("createWorkspaceActions", () => {
  beforeEach(() => {
    window.localStorage.clear();
    assets.persist.mockReset();
    assets.prune.mockReset();
    assets.prune.mockResolvedValue();
  });

  it("saves one at a time, each the project it was called for", async () => {
    const firstWrite = deferred();
    const secondWrite = deferred();
    assets.persist
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);
    const store = createWorkspaceStore({ activeFilePath: "index.html", project: lesson() });
    const actions = createWorkspaceActions(store);

    actions.updateFileContent("index.html", "first");
    const firstSave = actions.saveProject();
    actions.updateFileContent("index.html", "second");
    const secondSave = actions.saveProject();
    await vi.waitFor(() => expect(assets.persist).toHaveBeenCalledTimes(1));

    firstWrite.resolve();
    await firstSave;
    await vi.waitFor(() => expect(assets.persist).toHaveBeenCalledTimes(2));
    expect(isDirty(store)).toBe(true);

    secondWrite.resolve();
    await secondSave;
    expect(isDirty(store)).toBe(false);
    expect(
      assets.persist.mock.calls.map(([project]) => project.files["index.html"].content),
    ).toEqual(["first", "second"]);
    const persisted = JSON.parse(window.localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "null");
    expect(persisted.project.files["index.html"].content).toBe("second");
  });

  it("keeps the queue going after a failed save", async () => {
    assets.persist.mockRejectedValueOnce(new Error("quota")).mockResolvedValueOnce();
    const store = createWorkspaceStore({ activeFilePath: "index.html", project: lesson() });
    const actions = createWorkspaceActions(store);
    actions.updateFileContent("index.html", "edited");

    await actions.saveProject();
    expect(store.getSnapshot().context.saveError).toBe("quota");
    await actions.saveProject();
    expect(store.getSnapshot().context.saveError).toBeNull();
    expect(isDirty(store)).toBe(false);
  });

  it("does nothing a loaded project would be needed for until one is loaded", async () => {
    const store = createWorkspaceStore(null);
    const actions = createWorkspaceActions(store);

    await actions.saveProject();
    expect(assets.persist).not.toHaveBeenCalled();
    expect(actions.getProject()).toMatchObject({ id: "uninitialized", files: {} });
    expect(actions.getActiveFilePath()).toBe("");
    expect(actions.getFile("index.html")).toBeNull();

    actions.loadProject(lesson(), "missing.css");
    expect(actions.getProject().id).toBe("lesson");
    expect(actions.getActiveFilePath()).toBe("index.html");
    expect(isDirty(store)).toBe(false);
  });

  it("publishes an edit as a file mutation and a new file as a project mutation", () => {
    const store = createWorkspaceStore({ activeFilePath: "index.html", project: lesson() });
    const actions = createWorkspaceActions(store);
    const listener = vi.fn<(mutation: WorkspaceSyncMutation) => void>();
    const unsubscribe = actions.subscribeWorkspaceSync(listener);

    actions.updateFileContent("style.css", "p {}");
    actions.createFile("app.js", "");
    unsubscribe();
    actions.updateFileContent("style.css", "ignored");

    expect(listener.mock.calls.map(([mutation]) => mutation.kind)).toEqual(["file", "project"]);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ file: { path: "style.css" } });
  });
});
