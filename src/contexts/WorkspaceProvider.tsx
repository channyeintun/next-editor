import { useEffect, useState } from "react";
import { WorkspaceActionsContext } from "./WorkspaceContext";
import {
  WorkspaceStoreContext,
  createInitialWorkspaceSnapshot,
  createWorkspaceStore,
} from "../stores/workspaceStore";
import { createWorkspaceActions } from "../stores/workspaceActions";
import { migrateLegacyWorkspaceAssets } from "../storage/workspaceAssetStore";

interface WorkspaceProviderProps {
  children: React.ReactNode;
  /** Recording this surface is about to load, when it comes from a prop instead
   *  of `?url=` — see createInitialWorkspaceSnapshot. Start empty rather than
   *  from the persisted workspace, which the recording would only overwrite. */
  pendingRecordingUrl?: string;
  /** Save to the shared persisted workspace. Off where the workspace is not
   *  the user's project (see createWorkspaceActions). Defaults to on. */
  persist?: boolean;
}

export const WorkspaceProvider: React.FC<WorkspaceProviderProps> = ({
  children,
  pendingRecordingUrl,
  persist = true,
}) => {
  // Created once: the initial snapshot parses the whole saved workspace. The
  // actions are built over the store with it, so both are stable for the
  // provider's lifetime.
  const [{ workspaceStore, workspaceActions }] = useState(() => {
    const store = createWorkspaceStore(createInitialWorkspaceSnapshot(pendingRecordingUrl));
    return { workspaceStore: store, workspaceActions: createWorkspaceActions(store, { persist }) };
  });

  // Convert v1 generation/path binary entries to content-addressed descriptors.
  // The bytes remain in IndexedDB and are loaded only by a concrete consumer.
  useEffect(() => {
    let cancelled = false;
    const context = workspaceStore.getSnapshot().context;

    if (!context.isInitialized) {
      return;
    }

    void migrateLegacyWorkspaceAssets(context.project, context.savedSnapshot.assetGeneration)
      .then((descriptors) => {
        if (cancelled || Object.keys(descriptors).length === 0) {
          return;
        }

        workspaceStore.trigger.hydrateAssetDescriptors({ descriptors });
      })
      .catch((error) => {
        if (!cancelled) {
          workspaceStore.trigger.saveFailed({
            message:
              error instanceof Error
                ? error.message
                : "The saved binary workspace assets could not be loaded",
            workspaceLoadVersion: context.workspaceLoadVersion,
          });
        }
        console.warn("Failed to load workspace assets:", error);
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceStore]);

  return (
    <WorkspaceActionsContext value={workspaceActions}>
      <WorkspaceStoreContext value={workspaceStore}>{children}</WorkspaceStoreContext>
    </WorkspaceActionsContext>
  );
};
