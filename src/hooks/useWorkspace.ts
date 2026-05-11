import { type Context, useContext, useSyncExternalStore } from "react";
import {
  WorkspaceActionsContext,
  WorkspaceActiveFilePathContext,
  WorkspaceDirtyStateContext,
  WorkspaceEditorStateContext,
  WorkspaceFileCountContext,
  WorkspaceLessonTypeContext,
  WorkspacePreviewVersionContext,
  WorkspaceProjectNameContext,
  WorkspaceSaveVersionContext,
  WorkspaceSidebarStateContext,
  WorkspaceSyncVersionContext,
  type WorkspaceActions,
  type WorkspaceDirtyState,
  type WorkspaceEditorState,
  type WorkspaceSidebarState,
  type WorkspaceStore,
} from "../contexts/WorkspaceContext";
import type { WorkspaceLessonType } from "../types/workspace";

function useWorkspaceStore<T>(
  context: Context<WorkspaceStore<T> | null>,
  hookName: string,
): T {
  const store = useContext(context);

  if (!store) {
    throw new Error(`${hookName} must be used within a WorkspaceProvider`);
  }

  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
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
  return useWorkspaceStore(
    WorkspaceEditorStateContext,
    "useWorkspaceEditorState",
  );
};

export const useWorkspaceSidebarState = (): WorkspaceSidebarState => {
  return useWorkspaceStore(
    WorkspaceSidebarStateContext,
    "useWorkspaceSidebarState",
  );
};

export const useWorkspaceActiveFilePath = (): string => {
  return useWorkspaceStore(
    WorkspaceActiveFilePathContext,
    "useWorkspaceActiveFilePath",
  );
};

export const useWorkspaceLessonType = (): WorkspaceLessonType => {
  return useWorkspaceStore(
    WorkspaceLessonTypeContext,
    "useWorkspaceLessonType",
  );
};

export const useWorkspaceProjectName = (): string => {
  return useWorkspaceStore(
    WorkspaceProjectNameContext,
    "useWorkspaceProjectName",
  );
};

export const useWorkspaceFileCount = (): number => {
  return useWorkspaceStore(
    WorkspaceFileCountContext,
    "useWorkspaceFileCount",
  );
};

export const useWorkspacePreviewVersion = (): number => {
  return useWorkspaceStore(
    WorkspacePreviewVersionContext,
    "useWorkspacePreviewVersion",
  );
};

export const useWorkspaceDirtyState = (): WorkspaceDirtyState => {
  return useWorkspaceStore(
    WorkspaceDirtyStateContext,
    "useWorkspaceDirtyState",
  );
};

export const useWorkspaceSaveVersion = (): number => {
  return useWorkspaceStore(
    WorkspaceSaveVersionContext,
    "useWorkspaceSaveVersion",
  );
};

export const useWorkspaceSyncVersion = (): number => {
  return useWorkspaceStore(
    WorkspaceSyncVersionContext,
    "useWorkspaceSyncVersion",
  );
};
