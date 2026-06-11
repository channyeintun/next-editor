import { createContext } from "react";
import type { WorkspaceFile, WorkspaceLessonType, WorkspaceProject } from "../types/workspace";

export interface WorkspaceActions {
  setActiveFilePath: (path: string) => void;
  setPreviewFilePath: (path: string) => void;
  setCollapsedFolders: (paths: string[]) => void;
  setSidebarScrollTop: (scrollTop: number) => void;
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
  loadProject: (
    project: WorkspaceProject,
    activeFilePath?: string,
    collapsedFolders?: string[],
    sidebarScrollTop?: number,
  ) => void;
  resetProject: () => void;
  updateLessonType: (lessonType: WorkspaceLessonType) => void;
  getProject: () => WorkspaceProject;
  getActiveFilePath: () => string;
  getCollapsedFolders: () => string[];
  getSidebarScrollTop: () => number;
  getFile: (path: string) => WorkspaceFile | null;
  listFiles: () => WorkspaceFile[];
}

export interface WorkspaceEditorState {
  activeFile: WorkspaceFile;
  projectVersion: number;
}

export interface WorkspaceSidebarState {
  activeFilePath: string;
  files: WorkspaceFile[];
  folders: string[];
  collapsedFolders: string[];
  sidebarScrollTop: number;
  lessonType: WorkspaceLessonType;
  previewFilePath: string;
}

export interface WorkspaceDirtyState {
  dirtyFilePaths: string[];
  hasUnsavedChanges: boolean;
}

export const WorkspaceActionsContext = createContext<WorkspaceActions | null>(null);
