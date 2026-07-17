import { createContext } from "react";
import type {
  WorkspaceFile,
  WorkspaceFileEncoding,
  WorkspaceLessonType,
  WorkspaceProject,
  WorkspaceTreeFile,
} from "../types/workspace";
import type { TextEditEvent } from "../types/textEdit";

export interface WorkspaceActions {
  setActiveFilePath: (path: string) => void;
  setPreviewFilePath: (path: string) => void;
  setCollapsedFolders: (paths: string[]) => void;
  setSidebarScrollTop: (scrollTop: number) => void;
  setSidebarWidth: (width: number) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  createNewEditor: () => void;
  createFile: (path: string, content?: string, encoding?: WorkspaceFileEncoding) => void;
  createFolder: (path: string) => void;
  renameFile: (currentPath: string, nextPath: string) => void;
  renameFolder: (currentPath: string, nextPath: string) => void;
  deleteFile: (path: string) => void;
  deleteFolder: (path: string) => void;
  updateFileContent: (path: string, content: string) => void;
  applyFileTextEdits: (event: TextEditEvent) => string | null;
  updateActiveFileContent: (content: string) => void;
  hydrateAssetContents: (contents: Record<string, string>) => void;
  saveProject: () => Promise<void>;
  loadProject: (
    project: WorkspaceProject,
    activeFilePath?: string,
    collapsedFolders?: string[],
    sidebarScrollTop?: number,
    sidebarWidth?: number,
  ) => void;
  reconcileExternalProject: (project: WorkspaceProject) => void;
  updateLessonType: (lessonType: WorkspaceLessonType) => void;
  getProject: () => WorkspaceProject;
  getWorkspaceRevision: () => number;
  getActiveFilePath: () => string;
  getCollapsedFolders: () => string[];
  getSidebarScrollTop: () => number;
  getSidebarWidth: () => number;
  getFile: (path: string) => WorkspaceFile | null;
  listFiles: () => WorkspaceFile[];
  subscribeWorkspaceSync: (listener: (mutation: WorkspaceSyncMutation) => void) => () => void;
}

export type WorkspaceSyncMutation =
  | { kind: "file"; revision: number; file: WorkspaceFile }
  | { kind: "project"; revision: number; project: WorkspaceProject };

export interface WorkspaceEditorState {
  activeFile: WorkspaceFile;
  projectVersion: number;
}

export interface WorkspaceSidebarState {
  activeFilePath: string;
  files: WorkspaceTreeFile[];
  folders: string[];
  treeVersion: number;
  collapsedFolders: string[];
  sidebarScrollTop: number;
  sidebarWidth: number;
  lessonType: WorkspaceLessonType;
  previewFilePath: string;
}

export interface WorkspaceDirtyState {
  dirtyFilePaths: string[];
  addedFilePaths: string[];
  modifiedFilePaths: string[];
  deletedFilePaths: string[];
  projectMetadataChanged: boolean;
  folderStructureChanged: boolean;
  hasUnsavedChanges: boolean;
}

export interface WorkspaceSaveStatus {
  isSaving: boolean;
  errorMessage: string | null;
}

export const WorkspaceActionsContext = createContext<WorkspaceActions | null>(null);
