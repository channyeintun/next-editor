import { createContext } from "react";
import type {
  WorkspaceFile,
  WorkspaceLessonType,
  WorkspaceProject,
} from "../types/workspace";

export interface WorkspaceActions {
  setActiveFilePath: (path: string) => void;
  setPreviewFilePath: (path: string) => void;
  createNewEditor: () => void;
  createFile: (path: string, content?: string) => void;
  createFolder: (path: string) => void;
  renameFile: (currentPath: string, nextPath: string) => void;
  renameFolder: (currentPath: string, nextPath: string) => void;
  deleteFile: (path: string) => void;
  deleteFolder: (path: string) => void;
  updateFileContent: (path: string, content: string) => void;
  updateActiveFileContent: (content: string) => void;
  saveProject: () => void;
  loadProject: (project: WorkspaceProject, activeFilePath?: string) => void;
  resetProject: () => void;
  updateLessonType: (lessonType: WorkspaceLessonType) => void;
  getProject: () => WorkspaceProject;
  getActiveFilePath: () => string;
  getFile: (path: string) => WorkspaceFile | null;
  listFiles: () => WorkspaceFile[];
}

export interface WorkspaceStore<T> {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => T;
}

export interface WorkspaceEditorState {
  activeFile: WorkspaceFile;
  projectVersion: number;
}

export interface WorkspaceSidebarState {
  activeFilePath: string;
  files: WorkspaceFile[];
  folders: string[];
  lessonType: WorkspaceLessonType;
  previewFilePath: string;
}

export interface WorkspaceDirtyState {
  dirtyFilePaths: string[];
  hasUnsavedChanges: boolean;
}

export const WorkspaceActionsContext = createContext<WorkspaceActions | null>(
  null,
);
export const WorkspaceEditorStateContext =
  createContext<WorkspaceStore<WorkspaceEditorState> | null>(null);
export const WorkspaceSidebarStateContext =
  createContext<WorkspaceStore<WorkspaceSidebarState> | null>(null);
export const WorkspaceActiveFilePathContext =
  createContext<WorkspaceStore<string> | null>(null);
export const WorkspaceLessonTypeContext =
  createContext<WorkspaceStore<WorkspaceLessonType> | null>(null);
export const WorkspaceProjectNameContext =
  createContext<WorkspaceStore<string> | null>(null);
export const WorkspaceFileCountContext =
  createContext<WorkspaceStore<number> | null>(null);
export const WorkspacePreviewVersionContext =
  createContext<WorkspaceStore<number> | null>(null);
export const WorkspaceDirtyStateContext =
  createContext<WorkspaceStore<WorkspaceDirtyState> | null>(null);
export const WorkspaceSaveVersionContext =
  createContext<WorkspaceStore<number> | null>(null);
export const WorkspaceSyncVersionContext =
  createContext<WorkspaceStore<number> | null>(null);
