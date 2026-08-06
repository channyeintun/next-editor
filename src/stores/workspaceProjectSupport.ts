import { createStarterHtmlCssWorkspace } from "../starters/htmlCss";
import {
  collectWorkspaceFolders,
  DEFAULT_WORKSPACE_ENTRY_PATH,
  getParentWorkspacePath,
  getWorkspaceBaseName,
  inferLanguageFromPath,
  isWorkspaceAssetDescriptor,
  normalizeWorkspacePath,
  parseWorkspacePath,
  WorkspacePathError,
  type WorkspaceFile,
  type WorkspaceFileContent,
  type WorkspaceFileEncoding,
  type WorkspaceLessonType,
  type WorkspaceProject,
  type WorkspaceTreeFile,
} from "../types/workspace";

function areStringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function areWorkspaceFilesEqual(left: WorkspaceFile, right: WorkspaceFile): boolean {
  const contentEqual =
    typeof left.content === "string" && typeof right.content === "string"
      ? left.content === right.content
      : isWorkspaceAssetDescriptor(left.content) &&
        isWorkspaceAssetDescriptor(right.content) &&
        left.content.assetId === right.content.assetId &&
        left.content.mimeType === right.content.mimeType &&
        left.content.size === right.content.size;
  return (
    left.path === right.path &&
    left.name === right.name &&
    left.language === right.language &&
    contentEqual &&
    (left.encoding ?? "utf-8") === (right.encoding ?? "utf-8")
  );
}

export function projectSizeBucket(fileCount: number): "small" | "medium" | "large" {
  if (fileCount <= 25) return "small";
  if (fileCount <= 250) return "medium";
  return "large";
}

export function hasFilePathConflict(
  project: WorkspaceProject,
  path: string,
  ignoredPath?: string,
): boolean {
  if (project.folders.includes(path)) return true;
  return Object.keys(project.files).some(
    (existingPath) =>
      existingPath !== ignoredPath &&
      (existingPath === path ||
        existingPath.startsWith(`${path}/`) ||
        path.startsWith(`${existingPath}/`)),
  );
}

export function hasFolderPathConflict(project: WorkspaceProject, path: string): boolean {
  return Object.keys(project.files).some(
    (existingPath) => existingPath === path || path.startsWith(`${existingPath}/`),
  );
}

export function getDefaultFile(project: WorkspaceProject): WorkspaceFile {
  return (
    project.files[project.entryFilePath] ??
    project.files[DEFAULT_WORKSPACE_ENTRY_PATH] ??
    Object.values(project.files)[0] ?? {
      path: DEFAULT_WORKSPACE_ENTRY_PATH,
      name: "index.html",
      language: "html",
      content: "",
    }
  );
}

export function listProjectTreeFiles(project: WorkspaceProject): WorkspaceTreeFile[] {
  return Object.values(project.files)
    .map(({ path, name, language, encoding }) => ({
      path,
      name,
      language,
      ...(encoding ? { encoding } : {}),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function areWorkspaceTopologiesEqual(
  left: WorkspaceProject,
  right: WorkspaceProject,
): boolean {
  if (!areStringArraysEqual(left.folders, right.folders)) return false;
  const leftPaths = Object.keys(left.files).sort((first, second) => first.localeCompare(second));
  const rightPaths = Object.keys(right.files).sort((first, second) => first.localeCompare(second));
  if (!areStringArraysEqual(leftPaths, rightPaths)) return false;

  return leftPaths.every((path) => {
    const leftFile = left.files[path];
    const rightFile = right.files[path];
    return (
      leftFile.path === rightFile.path &&
      leftFile.name === rightFile.name &&
      leftFile.language === rightFile.language &&
      (leftFile.encoding ?? "utf-8") === (rightFile.encoding ?? "utf-8")
    );
  });
}

export function createWorkspaceFile(
  path: string,
  content: WorkspaceFileContent,
  encoding?: WorkspaceFileEncoding | "base64",
): WorkspaceFile {
  const normalizedPath = normalizeWorkspacePath(path);
  const metadata = {
    path: normalizedPath,
    name: getWorkspaceBaseName(normalizedPath),
    language: inferLanguageFromPath(normalizedPath),
  };
  if (encoding === "asset" && isWorkspaceAssetDescriptor(content)) {
    return { ...metadata, content, encoding };
  }
  if (encoding === "base64" && typeof content === "string") {
    return { ...metadata, content, encoding };
  }
  return { ...metadata, content: typeof content === "string" ? content : "" };
}

export function isPathWithinFolder(path: string, folderPath: string): boolean {
  return path === folderPath || path.startsWith(`${folderPath}/`);
}

export function replacePathPrefix(path: string, currentPrefix: string, nextPrefix: string): string {
  if (path === currentPrefix) return nextPrefix;
  return `${nextPrefix}${path.slice(currentPrefix.length)}`;
}

export function remapCollapsedFolders(
  collapsedFolders: string[],
  currentPrefix: string,
  nextPrefix: string,
): string[] {
  return collapsedFolders.map((folderPath) =>
    isPathWithinFolder(folderPath, currentPrefix)
      ? replacePathPrefix(folderPath, currentPrefix, nextPrefix)
      : folderPath,
  );
}

const KNOWN_LESSON_TYPES: ReadonlySet<WorkspaceLessonType> = new Set([
  "html-css",
  "react",
  "vue",
  "solid",
  "svelte",
  "htmx-express",
  "alpine-express",
  "express-ts",
  "javascript",
  "typescript",
  "go",
  "kotlin",
  "python",
  "rust",
  "kite",
]);

function inferWorkspaceLessonType(
  project: Pick<WorkspaceProject, "files"> & { lessonType?: string },
): WorkspaceLessonType {
  if (project.lessonType && KNOWN_LESSON_TYPES.has(project.lessonType as WorkspaceLessonType)) {
    return project.lessonType as WorkspaceLessonType;
  }
  return project.files["package.json"] || project.files["vite.config.js"] ? "react" : "html-css";
}

export class WorkspaceProjectValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceProjectValidationError";
  }
}

function canonicalizeProjectFiles(
  sourceFiles: Record<string, WorkspaceFile>,
): Record<string, WorkspaceFile> {
  const files = new Map<string, WorkspaceFile>();

  for (const [recordPath, file] of Object.entries(sourceFiles)) {
    try {
      const canonicalRecordPath = parseWorkspacePath(recordPath);
      const canonicalFilePath = parseWorkspacePath(file?.path || recordPath);
      if (canonicalRecordPath !== canonicalFilePath) {
        throw new WorkspaceProjectValidationError(
          `Workspace file key "${recordPath}" does not match its path "${file?.path ?? ""}"`,
        );
      }
      if (files.has(canonicalRecordPath)) {
        throw new WorkspaceProjectValidationError(
          `Multiple workspace files resolve to "${canonicalRecordPath}"`,
        );
      }
      if (!file) {
        throw new WorkspaceProjectValidationError(
          `Workspace file "${canonicalRecordPath}" has invalid content`,
        );
      }
      if (
        file.encoding !== undefined &&
        file.encoding !== "utf-8" &&
        file.encoding !== "asset" &&
        file.encoding !== "base64"
      ) {
        throw new WorkspaceProjectValidationError(
          `Workspace file "${canonicalRecordPath}" has an unsupported encoding`,
        );
      }
      if (
        (file.encoding === "asset" && !isWorkspaceAssetDescriptor(file.content)) ||
        (file.encoding !== "asset" && typeof file.content !== "string")
      ) {
        throw new WorkspaceProjectValidationError(
          `Workspace file "${canonicalRecordPath}" has invalid content`,
        );
      }
      files.set(
        canonicalRecordPath,
        createWorkspaceFile(
          canonicalRecordPath,
          file.content,
          file.encoding as WorkspaceFileEncoding | "base64" | undefined,
        ),
      );
    } catch (error) {
      if (error instanceof WorkspaceProjectValidationError) throw error;
      if (error instanceof WorkspacePathError) {
        throw new WorkspaceProjectValidationError(error.message, { cause: error });
      }
      throw error;
    }
  }

  for (const path of files.keys()) {
    let parentPath = getParentWorkspacePath(path);
    while (parentPath) {
      if (files.has(parentPath)) {
        throw new WorkspaceProjectValidationError(
          `Workspace path "${parentPath}" cannot be both a file and a directory`,
        );
      }
      parentPath = getParentWorkspacePath(parentPath);
    }
  }
  return Object.fromEntries(files);
}

export function normalizeProject(project: WorkspaceProject): WorkspaceProject {
  const fallbackProject = createStarterHtmlCssWorkspace();
  const suppliedFiles =
    project?.files && typeof project.files === "object"
      ? project.files
      : ({} as Record<string, WorkspaceFile>);
  const sourceFiles = Object.keys(suppliedFiles).length > 0 ? suppliedFiles : fallbackProject.files;
  const files = canonicalizeProjectFiles(sourceFiles);
  const explicitFolders = new Set<string>();

  for (const folderPath of Array.isArray(project?.folders) ? project.folders : []) {
    try {
      const canonicalFolderPath = parseWorkspacePath(folderPath);
      let currentFolderPath = canonicalFolderPath;
      while (currentFolderPath) {
        if (files[currentFolderPath]) {
          throw new WorkspaceProjectValidationError(
            `Workspace path "${currentFolderPath}" cannot be both a file and a directory`,
          );
        }
        currentFolderPath = getParentWorkspacePath(currentFolderPath);
      }
      explicitFolders.add(canonicalFolderPath);
    } catch (error) {
      if (error instanceof WorkspaceProjectValidationError) throw error;
      if (error instanceof WorkspacePathError) {
        throw new WorkspaceProjectValidationError(error.message, { cause: error });
      }
      throw error;
    }
  }

  const fallbackShape = { ...fallbackProject, ...project, files };
  const defaultFile = getDefaultFile(fallbackShape);
  const lessonType = inferWorkspaceLessonType(fallbackShape);
  const requestedEntryPath = normalizeWorkspacePath(project?.entryFilePath ?? "");
  const entryFilePath = files[requestedEntryPath] ? requestedEntryPath : defaultFile.path;

  return {
    ...fallbackProject,
    ...project,
    id: typeof project?.id === "string" && project.id.trim() ? project.id : fallbackProject.id,
    name:
      typeof project?.name === "string" && project.name.trim()
        ? project.name
        : fallbackProject.name,
    lessonType,
    entryFilePath,
    folders: collectWorkspaceFolders(Object.keys(files), Array.from(explicitFolders)),
    files,
  };
}
