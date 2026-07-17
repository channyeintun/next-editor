import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  WorkspaceActions,
  WorkspaceDirtyState,
  WorkspaceSaveStatus,
  WorkspaceSyncMutation,
} from "./WorkspaceContext";
import type { PersistWorkspaceAssetsOptions } from "../storage/workspaceAssetStore";
import type { WorkspaceProject } from "../types/workspace";

const assets = vi.hoisted(() => ({
  nextGeneration: 0,
  persist:
    vi.fn<(project: WorkspaceProject, options: PersistWorkspaceAssetsOptions) => Promise<void>>(),
  prune: vi.fn<() => Promise<void>>(),
}));

vi.mock("../storage/workspaceAssetStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage/workspaceAssetStore")>();
  return {
    ...actual,
    createWorkspaceAssetGeneration: () => `generation-${++assets.nextGeneration}`,
    persistWorkspaceAssets: assets.persist,
    pruneWorkspaceAssetGenerations: assets.prune,
  };
});

const { WorkspaceProvider } = await import("./WorkspaceProvider");
const { useWorkspaceActions, useWorkspaceDirtyState, useWorkspaceSaveStatus } =
  await import("../hooks/useWorkspace");
const { WORKSPACE_STORAGE_KEY } = await import("../stores/workspaceStore");

interface HarnessValue {
  actions: WorkspaceActions;
  dirty: WorkspaceDirtyState;
  save: WorkspaceSaveStatus;
}

function renderWorkspaceProvider(): { current: HarnessValue } {
  const captured = { current: null as HarnessValue | null };

  function Capture() {
    captured.current = {
      actions: useWorkspaceActions(),
      dirty: useWorkspaceDirtyState(),
      save: useWorkspaceSaveStatus(),
    };
    return null;
  }

  render(
    <WorkspaceProvider>
      <Capture />
    </WorkspaceProvider>,
  );

  if (!captured.current) throw new Error("Expected workspace provider harness");
  return captured as { current: HarnessValue };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolvePromise: (() => void) | null = null;
  let rejectPromise: ((error: Error) => void) | null = null;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
    reject: (error) => rejectPromise?.(error),
  };
}

describe("WorkspaceProvider durable asset saves", () => {
  beforeEach(() => {
    window.localStorage.clear();
    assets.nextGeneration = 0;
    assets.persist.mockReset();
    assets.prune.mockReset();
    assets.prune.mockResolvedValue();
  });

  it("publishes every file mutation and marks topology changes as project syncs", () => {
    const harness = renderWorkspaceProvider();
    const listener = vi.fn<(mutation: WorkspaceSyncMutation) => void>();
    const unsubscribe = harness.current.actions.subscribeWorkspaceSync(listener);
    const entryPath = harness.current.actions.getProject().entryFilePath;

    act(() => harness.current.actions.updateFileContent(entryPath, "first"));
    act(() => harness.current.actions.updateFileContent(entryPath, "latest"));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls.map(([mutation]) => mutation.kind)).toEqual(["file", "file"]);
    expect(listener.mock.calls[1]?.[0]).toMatchObject({
      kind: "file",
      file: { path: entryPath, content: "latest" },
    });

    act(() => harness.current.actions.createFolder("examples"));
    expect(listener.mock.calls[2]?.[0]).toMatchObject({ kind: "project" });
    unsubscribe();
  });

  it("keeps the workspace dirty and exposes an error when asset persistence fails", async () => {
    const failure = new Error("asset quota exceeded");
    assets.persist.mockRejectedValueOnce(failure);
    const harness = renderWorkspaceProvider();

    act(() => harness.current.actions.createFile("asset.bin", "QUJD", "base64"));
    expect(harness.current.dirty.hasUnsavedChanges).toBe(true);

    await act(async () => {
      await harness.current.actions.saveProject();
    });

    expect(harness.current.dirty.hasUnsavedChanges).toBe(true);
    expect(harness.current.save).toEqual({ isSaving: false, errorMessage: failure.message });
    expect(harness.current.actions.getProject().files["asset.bin"].content).toBe("QUJD");
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
  });

  it("serializes overlapping generations and marks only the committed snapshot clean", async () => {
    const firstWrite = deferred();
    const secondWrite = deferred();
    assets.persist
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);
    const harness = renderWorkspaceProvider();

    act(() => harness.current.actions.createFile("asset.bin", "QUJD", "base64"));
    let firstSave!: Promise<void>;
    act(() => {
      firstSave = harness.current.actions.saveProject();
    });
    await waitFor(() => expect(assets.persist).toHaveBeenCalledTimes(1));
    expect(harness.current.save.isSaving).toBe(true);
    expect(harness.current.dirty.hasUnsavedChanges).toBe(true);

    act(() => harness.current.actions.updateFileContent("asset.bin", "REVG"));
    let secondSave!: Promise<void>;
    act(() => {
      secondSave = harness.current.actions.saveProject();
    });
    expect(assets.persist).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstWrite.resolve();
      await firstSave;
    });
    await waitFor(() => expect(assets.persist).toHaveBeenCalledTimes(2));
    expect(harness.current.dirty.hasUnsavedChanges).toBe(true);

    await act(async () => {
      secondWrite.resolve();
      await secondSave;
    });

    expect(harness.current.dirty.hasUnsavedChanges).toBe(false);
    expect(harness.current.save).toEqual({ isSaving: false, errorMessage: null });
    expect(assets.persist.mock.calls[0]?.[0].files["asset.bin"].content).toBe("QUJD");
    expect(assets.persist.mock.calls[1]?.[0].files["asset.bin"].content).toBe("REVG");
    const persisted = JSON.parse(window.localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "null");
    expect(persisted.assetGeneration).toBe("generation-2");
    expect(persisted.project.files["asset.bin"].content).toBe("");
  });
});
