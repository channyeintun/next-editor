import { useContext } from "react";
import { useSelector } from "@xstate/store-react";
import {
  WorkspaceActionsContext,
  type WorkspaceActions,
  type WorkspaceDirtyState,
  type WorkspaceEditorState,
  type WorkspaceSidebarState,
} from "../contexts/WorkspaceContext";
import {
  WorkspaceStoreContext,
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
} from "../contexts/workspaceStore";
import type { WorkspaceLessonType } from "../types/workspace";

function useWorkspaceStore(hookName: string) {
  const store = useContext(WorkspaceStoreContext);

  if (!store) {
    throw new Error(`${hookName} must be used within a WorkspaceProvider`);
  }

  return store;
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
  const store = useWorkspaceStore("useWorkspaceEditorState");

  return useSelector(store, selectWorkspaceEditorState);
};

export const useWorkspaceSidebarState = (): WorkspaceSidebarState => {
  const store = useWorkspaceStore("useWorkspaceSidebarState");

  return useSelector(store, selectWorkspaceSidebarState);
};

export const useWorkspaceActiveFilePath = (): string => {
  const store = useWorkspaceStore("useWorkspaceActiveFilePath");

  return useSelector(store, selectWorkspaceActiveFilePath);
};

export const useWorkspaceLessonType = (): WorkspaceLessonType => {
  const store = useWorkspaceStore("useWorkspaceLessonType");

  return useSelector(store, selectWorkspaceLessonType);
};

export const useWorkspaceProjectName = (): string => {
  const store = useWorkspaceStore("useWorkspaceProjectName");

  return useSelector(store, selectWorkspaceProjectName);
};

export const useWorkspaceFileCount = (): number => {
  const store = useWorkspaceStore("useWorkspaceFileCount");

  return useSelector(store, selectWorkspaceFileCount);
};

export const useWorkspacePreviewVersion = (): number => {
  const store = useWorkspaceStore("useWorkspacePreviewVersion");

  return useSelector(store, selectWorkspacePreviewVersion);
};

export const useWorkspaceDirtyState = (): WorkspaceDirtyState => {
  const store = useWorkspaceStore("useWorkspaceDirtyState");

  return useSelector(store, selectWorkspaceDirtyState);
};

export const useWorkspaceSaveVersion = (): number => {
  const store = useWorkspaceStore("useWorkspaceSaveVersion");

  return useSelector(store, selectWorkspaceSaveVersion);
};

export const useWorkspaceSyncVersion = (): number => {
  const store = useWorkspaceStore("useWorkspaceSyncVersion");

  return useSelector(store, selectWorkspaceSyncVersion);
};
