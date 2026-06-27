import { unzipSync, strFromU8 } from "fflate";
import {
  bytesToBase64,
  collectWorkspaceFolders,
  getWorkspaceBaseName,
  inferLanguageFromPath,
  isBinaryWorkspacePath,
  normalizeWorkspacePath,
  type WorkspaceFile,
  type WorkspaceLessonType,
  type WorkspaceProject,
} from "../types/workspace";

/**
 * Upper bound on the decoded size of an imported archive. Imported projects are
 * mirrored into the WebContainer filesystem and (for text) kept in the
 * localStorage snapshot, so an unbounded zip would blow past the storage budget
 * and stall the runtime. 50 MB matches the per-asset cap used for local uploads.
 */
export const MAX_IMPORTED_PROJECT_BYTES = 50 * 1024 * 1024;

/**
 * Development artifacts that should never travel into the workspace: they are
 * either reconstructable (`node_modules` is rebuilt by `npm install`), VCS
 * metadata, or OS/editor junk. Stripping them keeps the import small and the
 * file tree focused on the user's source.
 */
const IGNORED_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".next",
  ".cache",
  "__MACOSX",
]);

const IGNORED_FILE_NAMES: ReadonlySet<string> = new Set([".DS_Store", "Thumbs.db"]);

/** Entry-file candidates, most "interesting" source files first. */
const ENTRY_FILE_CANDIDATES: readonly string[] = [
  "src/App.tsx",
  "src/App.jsx",
  "src/App.vue",
  "src/App.svelte",
  "src/App.ts",
  "src/App.js",
  "src/main.tsx",
  "src/main.ts",
  "src/main.jsx",
  "src/main.js",
  "src/index.tsx",
  "src/index.ts",
  "index.html",
  "public/index.html",
];

export class WorkspaceZipImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceZipImportError";
  }
}

function shouldIgnoreImportPath(path: string): boolean {
  if (IGNORED_FILE_NAMES.has(getWorkspaceBaseName(path))) {
    return true;
  }

  return path.split("/").some((segment) => IGNORED_PATH_SEGMENTS.has(segment));
}

/**
 * Folder-archives created by "compress this folder" wrap everything in a single
 * top-level directory (e.g. `my-app/package.json`). Detect that wrapper and
 * return a mapper that strips it so files land at the workspace root; return the
 * identity mapper when entries already live at the root.
 */
export function createRootFolderStripper(filePaths: string[]): (path: string) => string {
  if (filePaths.length === 0) {
    return (path) => path;
  }

  const firstSegment = filePaths[0].split("/")[0];
  const prefix = `${firstSegment}/`;
  const allShareWrapper =
    Boolean(firstSegment) && filePaths.every((path) => path.startsWith(prefix));

  if (!allShareWrapper) {
    return (path) => path;
  }

  return (path) => path.slice(prefix.length);
}

/** Detect the closest supported framework from an imported project's manifest. */
export function detectImportedLessonType(
  files: Record<string, WorkspaceFile>,
): WorkspaceLessonType {
  const packageJsonFile = files["package.json"];

  if (!packageJsonFile || packageJsonFile.encoding === "base64") {
    return "html-css";
  }

  try {
    const packageJson = JSON.parse(packageJsonFile.content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    if (dependencies.vue) {
      return "vue";
    }

    if (dependencies.svelte) {
      return "svelte";
    }

    if (dependencies["solid-js"]) {
      return "solid";
    }

    if (dependencies.react || dependencies["react-dom"]) {
      return "react";
    }

    if (dependencies["htmx.org"]) {
      return "htmx-express";
    }

    if (dependencies.express && (dependencies.tsx || dependencies["@types/express"])) {
      return "express-ts";
    }

    if (dependencies.express) {
      return "htmx-express";
    }
  } catch {
    return "html-css";
  }

  // A manifest without a recognized framework still runs under Vite (html-css
  // boots a bare Vite dev server), which is the safest generic fallback.
  return "html-css";
}

function pickEntryFilePath(files: Record<string, WorkspaceFile>): string {
  for (const candidate of ENTRY_FILE_CANDIDATES) {
    if (files[candidate]) {
      return candidate;
    }
  }

  const firstTextFile = Object.values(files).find((file) => file.encoding !== "base64");

  return firstTextFile?.path ?? Object.values(files)[0]?.path ?? "index.html";
}

/** Strip the `.zip` suffix and tidy a file name into a human-readable project name. */
export function deriveProjectNameFromFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.zip$/i, "");
  const baseName = getWorkspaceBaseName(normalizeWorkspacePath(withoutExtension)).trim();

  return baseName || "Imported Project";
}

function toProjectId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `imported-${slug || "project"}`;
}

function createWorkspaceFile(
  path: string,
  content: string,
  encoding: "base64" | undefined,
): WorkspaceFile {
  const normalizedPath = normalizeWorkspacePath(path);

  return {
    path: normalizedPath,
    name: getWorkspaceBaseName(normalizedPath),
    language: inferLanguageFromPath(normalizedPath),
    content,
    ...(encoding ? { encoding } : {}),
  };
}

/**
 * Parse an uploaded `.zip` into a {@link WorkspaceProject} that can be handed to
 * `loadProject`, exactly like selecting a starter template — only the contents
 * come from the user's own project rather than a built-in one. Everything runs
 * in the browser; nothing is uploaded to a server.
 */
export async function importWorkspaceProjectFromZip(file: File): Promise<WorkspaceProject> {
  let archive: Record<string, Uint8Array>;

  try {
    archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new WorkspaceZipImportError(
      "That file could not be read as a .zip archive. Please pick a valid zip file.",
    );
  }

  // Collect importable entries (skip directories and ignored artifacts) before
  // detecting a common wrapper folder so the strip decision sees only real files.
  const entries = Object.entries(archive).filter(([name]) => {
    if (name.endsWith("/")) {
      return false;
    }

    const normalizedPath = normalizeWorkspacePath(name);

    return Boolean(normalizedPath) && !shouldIgnoreImportPath(normalizedPath);
  });

  if (entries.length === 0) {
    throw new WorkspaceZipImportError(
      "The zip did not contain any importable files. Make sure it holds your project's source files.",
    );
  }

  const stripRootFolder = createRootFolderStripper(
    entries.map(([name]) => normalizeWorkspacePath(name)),
  );

  const files: Record<string, WorkspaceFile> = {};
  let totalBytes = 0;

  for (const [name, bytes] of entries) {
    const workspacePath = stripRootFolder(normalizeWorkspacePath(name));

    if (!workspacePath) {
      continue;
    }

    totalBytes += bytes.byteLength;

    if (totalBytes > MAX_IMPORTED_PROJECT_BYTES) {
      throw new WorkspaceZipImportError(
        `This project is larger than the ${Math.round(
          MAX_IMPORTED_PROJECT_BYTES / (1024 * 1024),
        )} MB import limit. Remove large assets and try again.`,
      );
    }

    if (isBinaryWorkspacePath(workspacePath)) {
      files[workspacePath] = createWorkspaceFile(workspacePath, bytesToBase64(bytes), "base64");
    } else {
      files[workspacePath] = createWorkspaceFile(workspacePath, strFromU8(bytes), undefined);
    }
  }

  const name = deriveProjectNameFromFileName(file.name);

  return {
    id: toProjectId(name),
    name,
    lessonType: detectImportedLessonType(files),
    entryFilePath: pickEntryFilePath(files),
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
