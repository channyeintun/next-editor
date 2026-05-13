import { useContext, useSyncExternalStore } from "react";
import {
  WorkspaceActionsContext,
  type WorkspaceActions,
  type WorkspaceDirtyState,
  type WorkspaceEditorState,
  type WorkspaceSidebarState,
} from "../contexts/WorkspaceContext";
import {
  WorkspaceStoreContext,
  type WorkspaceStoreSnapshot,
  selectWorkspaceActiveFilePath,
  selectWorkspaceDirtyState,
  selectWorkspaceEditorState,
  selectWorkspaceFileCount,
  selectWorkspaceLessonType,
  selectWorkspacePreviewVersion,
  selectWorkspaceProjectName,
  selectWorkspaceSaveVersion,
  selectWorkspaceSidebarState,
  selectWorkspaceSyncVersion,
} from "../stores/workspaceStore";
import type { WorkspaceLessonType } from "../types/workspace";

function useWorkspaceStore(hookName: string) {
  const store = useContext(WorkspaceStoreContext);

  if (!store) {
    throw new Error(`${hookName} must be used within a WorkspaceProvider`);
  }

  return store;
}

function useWorkspaceSelector<T>(
  hookName: string,
  selector: (snapshot: WorkspaceStoreSnapshot) => T,
): T {
  const store = useWorkspaceStore(hookName);

  // Replay seeks apply workspace snapshots through one store emission; subscribe
  // at that boundary so active-file, sidebar, and version selectors stay aligned.
  return useSyncExternalStore(
    (onStoreChange) => {
      const subscription = store.subscribe(() => {
        onStoreChange();
      });

      return () => {
        subscription.unsubscribe();
      };
    },
    () => selector(store.getSnapshot()),
    () => selector(store.getSnapshot()),
  );
}

export const useWorkspaceActions = (): WorkspaceActions => {
  const context = useContext(WorkspaceActionsContext);

  if (!context) {
    throw new Error(
      "useWorkspaceActions must be used within a WorkspaceProvider",
    );
  }

  return context;
};

export const useWorkspaceEditorState = (): WorkspaceEditorState => {
  return useWorkspaceSelector(
    "useWorkspaceEditorState",
    selectWorkspaceEditorState,
  );
};

export const useWorkspaceSidebarState = (): WorkspaceSidebarState => {
  return useWorkspaceSelector(
    "useWorkspaceSidebarState",
    selectWorkspaceSidebarState,
  );
};

export const useWorkspaceActiveFilePath = (): string => {
  return useWorkspaceSelector(
    "useWorkspaceActiveFilePath",
    selectWorkspaceActiveFilePath,
  );
};

export const useWorkspaceLessonType = (): WorkspaceLessonType => {
  return useWorkspaceSelector(
    "useWorkspaceLessonType",
    selectWorkspaceLessonType,
  );
};

export const useWorkspaceProjectName = (): string => {
  return useWorkspaceSelector(
    "useWorkspaceProjectName",
    selectWorkspaceProjectName,
  );
};

export const useWorkspaceFileCount = (): number => {
  return useWorkspaceSelector(
    "useWorkspaceFileCount",
    selectWorkspaceFileCount,
  );
};

export const useWorkspacePreviewVersion = (): number => {
  return useWorkspaceSelector(
    "useWorkspacePreviewVersion",
    selectWorkspacePreviewVersion,
  );
};

export const useWorkspaceDirtyState = (): WorkspaceDirtyState => {
  return useWorkspaceSelector(
    "useWorkspaceDirtyState",
    selectWorkspaceDirtyState,
  );
};

export const useWorkspaceSaveVersion = (): number => {
  return useWorkspaceSelector(
    "useWorkspaceSaveVersion",
    selectWorkspaceSaveVersion,
  );
};

export const useWorkspaceSyncVersion = (): number => {
  return useWorkspaceSelector(
    "useWorkspaceSyncVersion",
    selectWorkspaceSyncVersion,
  );
};
