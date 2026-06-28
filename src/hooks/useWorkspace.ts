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
  type WorkspaceState,
  selectWorkspaceActiveFilePath,
  selectWorkspaceDirtyState,
  selectWorkspaceEditorState,
  selectWorkspaceFileCount,
  selectWorkspaceLessonType,
  selectWorkspacePreviewVersion,
  selectWorkspaceProjectVersion,
  selectWorkspaceProjectName,
  selectWorkspaceProjectId,
  selectWorkspaceSaveVersion,
  selectWorkspaceSidebarCollapsed,
  selectWorkspaceSidebarState,
  selectWorkspaceSidebarWidth,
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

function useWorkspaceSelector<T>(hookName: string, selector: (context: WorkspaceState) => T): T {
  const store = useWorkspaceStore(hookName);

  return useSelector(store, (snapshot) => selector(snapshot.context));
}

export const useWorkspaceActions = (): WorkspaceActions => {
  const context = useContext(WorkspaceActionsContext);

  if (!context) {
    throw new Error("useWorkspaceActions must be used within a WorkspaceProvider");
  }

  return context;
};

export const useWorkspaceEditorState = (): WorkspaceEditorState => {
  return useWorkspaceSelector("useWorkspaceEditorState", selectWorkspaceEditorState);
};

export const useWorkspaceSidebarState = (): WorkspaceSidebarState => {
  return useWorkspaceSelector("useWorkspaceSidebarState", selectWorkspaceSidebarState);
};

export const useWorkspaceSidebarWidth = (): number => {
  return useWorkspaceSelector("useWorkspaceSidebarWidth", selectWorkspaceSidebarWidth);
};

export const useWorkspaceSidebarCollapsed = (): boolean => {
  return useWorkspaceSelector("useWorkspaceSidebarCollapsed", selectWorkspaceSidebarCollapsed);
};

export const useWorkspaceActiveFilePath = (): string => {
  return useWorkspaceSelector("useWorkspaceActiveFilePath", selectWorkspaceActiveFilePath);
};

export const useWorkspaceLessonType = (): WorkspaceLessonType => {
  return useWorkspaceSelector("useWorkspaceLessonType", selectWorkspaceLessonType);
};

export const useWorkspaceProjectName = (): string => {
  return useWorkspaceSelector("useWorkspaceProjectName", selectWorkspaceProjectName);
};

export const useWorkspaceProjectVersion = (): number => {
  return useWorkspaceSelector("useWorkspaceProjectVersion", selectWorkspaceProjectVersion);
};

export const useWorkspaceProjectId = (): string => {
  return useWorkspaceSelector("useWorkspaceProjectId", selectWorkspaceProjectId);
};

export const useWorkspaceFileCount = (): number => {
  return useWorkspaceSelector("useWorkspaceFileCount", selectWorkspaceFileCount);
};

export const useWorkspacePreviewVersion = (): number => {
  return useWorkspaceSelector("useWorkspacePreviewVersion", selectWorkspacePreviewVersion);
};

export const useWorkspaceDirtyState = (): WorkspaceDirtyState => {
  return useWorkspaceSelector("useWorkspaceDirtyState", selectWorkspaceDirtyState);
};

export const useWorkspaceSaveVersion = (): number => {
  return useWorkspaceSelector("useWorkspaceSaveVersion", selectWorkspaceSaveVersion);
};

export const useWorkspaceSyncVersion = (): number => {
  return useWorkspaceSelector("useWorkspaceSyncVersion", selectWorkspaceSyncVersion);
};
