import { createContext } from "react";
import type {
  WorkspaceFile,
  WorkspaceLessonType,
  WorkspaceProject,
} from "../types/workspace";

export interface WorkspaceActions {
  setActiveFilePath: (path: string) => void;
  createFile: (path: string, content?: string) => void;
  createFolder: (path: string) => void;
  renameFile: (currentPath: string, nextPath: string) => void;
  deleteFile: (path: string) => void;
  updateFileContent: (path: string, content: string) => void;
  updateActiveFileContent: (content: string) => void;
  saveProject: () => void;
  loadProject: (project: WorkspaceProject) => void;
  resetProject: () => void;
  updateLessonType: (lessonType: WorkspaceLessonType) => void;
  getProject: () => WorkspaceProject;
  getFile: (path: string) => WorkspaceFile | null;
  listFiles: () => WorkspaceFile[];
}

export interface WorkspaceMetadata {
  activeFilePath: string;
  activeFile: WorkspaceFile;
  files: WorkspaceFile[];
  dirtyFilePaths: string[];
  folders: string[];
  fileCount: number;
  hasUnsavedChanges: boolean;
  projectName: string;
  lessonType: WorkspaceLessonType;
  projectVersion: number;
  syncVersion: number;
}

export const WorkspaceActionsContext = createContext<WorkspaceActions | null>(
  null,
);
export const WorkspaceMetadataContext = createContext<WorkspaceMetadata | null>(
  null,
);
