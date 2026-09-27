// Moves workspace files into and out of a WebContainer: the tree a project
// mounts as, the writes and removals that bring the container up to a newer
// project, and the read that turns the container's files back into a project.
import type { FileSystemTree, WebContainer } from "@webcontainer/api";
import {
  base64ToBytes,
  collectWorkspaceFolders,
  getWorkspaceBaseName,
  getWorkspaceFileMimeType,
  inferLanguageFromPath,
  isBinaryWorkspacePath,
  isLegacyWorkspaceBinaryFile,
  isWorkspaceAssetFile,
  isWorkspaceTextFile,
  normalizeWorkspacePath,
  parseWorkspacePath,
  type WorkspaceFile,
  type WorkspaceProject,
} from "../../types/workspace";
import { getWorkspaceAssetBytes, registerWorkspaceAsset } from "../../storage/workspaceAssetStore";

const RUNTIME_IMPORT_IGNORED_ROOTS = new Set([".git", "node_modules"]);

function getNormalizedProjectFiles(project: WorkspaceProject | null): Map<string, WorkspaceFile> {
  if (!project) {
    return new Map();
  }

  const files = new Map<string, WorkspaceFile>();

  for (const [path, file] of Object.entries(project.files)) {
    const normalizedPath = parseWorkspacePath(path);
    const normalizedFilePath = parseWorkspacePath(file.path);

    if (normalizedPath !== normalizedFilePath) {
      throw new Error(`Workspace file key "${path}" does not match its path "${file.path}"`);
    }

    if (files.has(normalizedPath)) {
      throw new Error(`Multiple workspace files resolve to "${normalizedPath}"`);
    }

    files.set(normalizedPath, file);
  }

  for (const path of files.keys()) {
    const segments = path.split("/");
    segments.pop();
    while (segments.length > 0) {
      const parentPath = segments.join("/");
      if (files.has(parentPath)) {
        throw new Error(`Workspace path "${parentPath}" conflicts with a nested file`);
      }
      segments.pop();
    }
  }

  return files;
}

function stripRuntimeSnapshotScript(content: string): string {
  return content
    .replace(/\s*<script data-next-editor-rrweb-record>[\s\S]*?<\/script>\s*/g, "\n")
    .replace(/\s*<script data-next-editor-runtime-snapshot>[\s\S]*?<\/script>\s*/g, "\n")
    .replace(/\s*<script data-next-editor-api-client-proxy>[\s\S]*?<\/script>\s*/g, "\n");
}

export function shouldIgnoreRuntimeImportPath(path: string): boolean {
  const normalizedPath = normalizeWorkspacePath(path);
  const rootSegment = normalizedPath.split("/")[0];

  return rootSegment ? RUNTIME_IMPORT_IGNORED_ROOTS.has(rootSegment) : false;
}

async function readRuntimeDirectory(
  instance: WebContainer,
  runtimePath: string,
  workspacePath: string,
  files: Record<string, WorkspaceFile>,
  folders: Set<string>,
): Promise<void> {
  const entries = await instance.fs.readdir(runtimePath, { withFileTypes: true });
  const orderedEntries = [...entries].sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of orderedEntries) {
    const nextWorkspacePath = parseWorkspacePath(
      workspacePath ? `${workspacePath}/${entry.name}` : entry.name,
    );
    const nextRuntimePath = runtimePath === "." ? entry.name : `${runtimePath}/${entry.name}`;

    if (shouldIgnoreRuntimeImportPath(nextWorkspacePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      folders.add(nextWorkspacePath);
      await readRuntimeDirectory(instance, nextRuntimePath, nextWorkspacePath, files, folders);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (isBinaryWorkspacePath(nextWorkspacePath)) {
      const bytes = await instance.fs.readFile(nextRuntimePath);
      const content = await registerWorkspaceAsset(bytes, {
        mimeType: getWorkspaceFileMimeType(nextWorkspacePath),
      });

      files[nextWorkspacePath] = {
        path: nextWorkspacePath,
        name: getWorkspaceBaseName(nextWorkspacePath),
        language: inferLanguageFromPath(nextWorkspacePath),
        content,
        encoding: "asset",
      };
      continue;
    }

    const content = stripRuntimeSnapshotScript(
      await instance.fs.readFile(nextRuntimePath, "utf-8"),
    );

    files[nextWorkspacePath] = {
      path: nextWorkspacePath,
      name: getWorkspaceBaseName(nextWorkspacePath),
      language: inferLanguageFromPath(nextWorkspacePath),
      content,
    };
  }
}

export async function readWorkspaceProject(
  instance: WebContainer,
  currentProject: WorkspaceProject,
): Promise<WorkspaceProject> {
  const files: Record<string, WorkspaceFile> = {};
  const folders = new Set<string>();

  await readRuntimeDirectory(instance, ".", "", files, folders);

  return {
    ...currentProject,
    folders: collectWorkspaceFolders(Object.keys(files), Array.from(folders)),
    files,
  };
}

export async function getWorkspaceRuntimeFileContents(
  file: WorkspaceFile,
): Promise<string | Uint8Array> {
  if (isWorkspaceAssetFile(file)) return getWorkspaceAssetBytes(file.content);
  if (isLegacyWorkspaceBinaryFile(file)) return base64ToBytes(file.content);
  return file.content;
}

function workspaceFileContentsEqual(left: WorkspaceFile, right: WorkspaceFile): boolean {
  if (isWorkspaceAssetFile(left) && isWorkspaceAssetFile(right)) {
    return left.content.assetId === right.content.assetId;
  }
  return isWorkspaceTextFile(left) && isWorkspaceTextFile(right) && left.content === right.content;
}

export async function createWorkspaceTree(project: WorkspaceProject): Promise<FileSystemTree> {
  const createDirectory = (): FileSystemTree => Object.create(null) as FileSystemTree;
  const tree = createDirectory();

  /** Returns the tree's node for `directoryPath`, creating any missing levels. */
  const ensureTreeDirectory = (directoryPath: string): FileSystemTree => {
    const normalizedDirectoryPath = directoryPath ? parseWorkspacePath(directoryPath) : "";
    let currentDirectory = tree;

    if (!normalizedDirectoryPath) {
      return currentDirectory;
    }

    for (const segment of normalizedDirectoryPath.split("/")) {
      const entry = currentDirectory[segment] ?? { directory: createDirectory() };

      if (!("directory" in entry)) {
        throw new Error(`Workspace path "${normalizedDirectoryPath}" conflicts with a file`);
      }

      currentDirectory[segment] = entry;
      currentDirectory = entry.directory;
    }

    return currentDirectory;
  };

  for (const folderPath of project.folders) {
    ensureTreeDirectory(folderPath);
  }

  for (const [normalizedPath, file] of getNormalizedProjectFiles(project)) {
    const segments = normalizedPath.split("/");
    const fileName = segments.pop();

    if (!fileName) {
      continue;
    }

    const directory = ensureTreeDirectory(segments.join("/"));

    if (directory[fileName]) {
      throw new Error(`Workspace path "${normalizedPath}" conflicts with another entry`);
    }

    directory[fileName] = {
      file: {
        // The recorder is injected at the preview layer (see
        // createRuntimePreviewScript + setPreviewScript), never written into
        // workspace files, so files are mounted exactly as authored.
        contents: await getWorkspaceRuntimeFileContents(file),
      },
    };
  }

  return tree;
}

async function ensureDirectory(
  instance: WebContainer,
  directoryPath: string,
  onWrite?: (path: string) => void,
): Promise<void> {
  const segments = directoryPath.split("/").filter(Boolean);

  if (segments.length === 0) {
    return;
  }

  // fs.watch reports every level this may create, so each one is reported.
  for (let depth = 1; depth <= segments.length; depth += 1) {
    onWrite?.(segments.slice(0, depth).join("/"));
  }

  try {
    await instance.fs.mkdir(segments.join("/"), { recursive: true });
  } catch {
    // A file this sync has yet to delete can still hold the path (folders are
    // created before deleted files are removed); the write that needs the
    // folder calls this again after the removal.
  }
}

function getFileDirectory(path: string): string {
  const segments = path.split("/").slice(0, -1);
  return segments.join("/");
}

export async function syncWorkspaceProject(
  instance: WebContainer,
  previousProject: WorkspaceProject | null,
  nextProject: WorkspaceProject,
  // Reports every container path this sync mutates (created folders, removed
  // paths, written files) so callers can tell their own writes apart from
  // container-originated ones — e.g. to suppress fs.watch echoes.
  onWrite?: (path: string) => void,
): Promise<void> {
  if (previousProject === nextProject) {
    return;
  }

  const previousFiles = getNormalizedProjectFiles(previousProject);
  const nextFiles = getNormalizedProjectFiles(nextProject);
  const previousFolders = new Set(
    (previousProject?.folders ?? []).map((folderPath) => parseWorkspacePath(folderPath)),
  );
  const nextFolders = new Set(
    nextProject.folders.map((folderPath) => parseWorkspacePath(folderPath)),
  );

  for (const folderPath of nextProject.folders) {
    const normalizedFolderPath = parseWorkspacePath(folderPath);

    if (previousFolders.has(normalizedFolderPath)) {
      continue;
    }

    await ensureDirectory(instance, normalizedFolderPath, onWrite);
  }

  const deletedPaths = Array.from(previousFiles.keys()).filter((path) => !nextFiles.has(path));

  for (const path of deletedPaths.sort((left, right) => right.length - left.length)) {
    onWrite?.(path);

    try {
      await instance.fs.rm(path);
    } catch {
      // Ignore files that are already absent.
    }
  }

  const deletedFolders = Array.from(previousFolders).filter(
    (folderPath) => !nextFolders.has(folderPath),
  );

  for (const folderPath of deletedFolders.sort((left, right) => right.length - left.length)) {
    onWrite?.(folderPath);

    try {
      await instance.fs.rm(folderPath, { recursive: true, force: true });
    } catch {
      // Ignore directories that are already absent.
    }
  }

  for (const [path, file] of nextFiles) {
    const previousFile = previousFiles.get(path);

    if (previousFile && workspaceFileContentsEqual(previousFile, file)) {
      continue;
    }

    await ensureDirectory(instance, getFileDirectory(path), onWrite);
    onWrite?.(path);
    await instance.fs.writeFile(path, await getWorkspaceRuntimeFileContents(file));
  }
}
