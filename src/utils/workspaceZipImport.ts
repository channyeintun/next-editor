import { unzipSync, strFromU8 } from "fflate";
import {
  collectWorkspaceFolders,
  getWorkspaceBaseName,
  getWorkspaceFileMimeType,
  inferLanguageFromPath,
  isBinaryWorkspacePath,
  isWorkspaceAssetDescriptor,
  isWorkspaceTextFile,
  normalizeWorkspacePath,
  parseWorkspacePath,
  WorkspacePathError,
  type WorkspaceFile,
  type WorkspaceFileContent,
  type WorkspaceFileEncoding,
  type WorkspaceLessonType,
  type WorkspaceProject,
} from "../types/workspace";
import { registerWorkspaceAsset } from "../storage/workspaceAssetStore";

/**
 * Upper bound on the decoded size of an imported archive. Imported projects are
 * mirrored into the WebContainer filesystem and (for text) kept in the
 * localStorage snapshot, so an unbounded zip would blow past the storage budget
 * and stall the runtime. 50 MB matches the per-asset cap used for local uploads.
 */
export const MAX_IMPORTED_PROJECT_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORTED_PROJECT_ENTRIES = 10_000;
export const MAX_IMPORTED_ARCHIVE_BYTES = 100 * 1024 * 1024;

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

/** Whether any text HTML file in the project contains the given substring. */
function htmlReferences(files: Record<string, WorkspaceFile>, needle: string): boolean {
  return Object.values(files).some(
    (file) =>
      isWorkspaceTextFile(file) && /\.html?$/i.test(file.path) && file.content.includes(needle),
  );
}

/**
 * Playground lesson shapes carry no package.json manifest: their sources are
 * compiled by the language's playground proxy, or — for assembly — by the
 * first-party assembler in the page. Ordered so the canonical entry file
 * decides first when an archive mixes languages, matching the runner
 * collectors in src/runtime/{go,rust,kotlin,zig,asm}Playground/files.ts.
 */
const PLAYGROUND_LESSON_RULES: ReadonlyArray<{
  lessonType: Extract<WorkspaceLessonType, "go" | "rust" | "kotlin" | "zig" | "asm">;
  entryPath: string;
  /**
   * Every extension the language's runner collector accepts. Assembly has
   * three; a single-extension probe here would fail to recognize an archive of
   * `.s` files that the runner would then happily assemble.
   */
  extensions: readonly string[];
}> = [
  { lessonType: "go", entryPath: "main.go", extensions: [".go"] },
  { lessonType: "rust", entryPath: "main.rs", extensions: [".rs"] },
  { lessonType: "kotlin", entryPath: "Main.kt", extensions: [".kt"] },
  { lessonType: "zig", entryPath: "main.zig", extensions: [".zig"] },
  { lessonType: "asm", entryPath: "main.asm", extensions: [".asm", ".s", ".nasm"] },
];

function detectPlaygroundLessonType(
  files: Record<string, WorkspaceFile>,
): WorkspaceLessonType | null {
  for (const rule of PLAYGROUND_LESSON_RULES) {
    const entry = files[rule.entryPath];
    if (entry && isWorkspaceTextFile(entry)) {
      return rule.lessonType;
    }
  }

  for (const rule of PLAYGROUND_LESSON_RULES) {
    const hasSource = Object.values(files).some(
      (file) =>
        isWorkspaceTextFile(file) &&
        rule.extensions.some((extension) => file.path.endsWith(extension)),
    );
    if (hasSource) {
      return rule.lessonType;
    }
  }

  return null;
}

/** Detect the closest supported framework from an imported project's manifest. */
export function detectImportedLessonType(
  files: Record<string, WorkspaceFile>,
): WorkspaceLessonType {
  const packageJsonFile = files["package.json"];

  if (!packageJsonFile || !isWorkspaceTextFile(packageJsonFile)) {
    return detectPlaygroundLessonType(files) ?? "html-css";
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

    // Alpine AJAX (like htmx) is usually pulled from a CDN rather than installed,
    // so also sniff the HTML for its CDN reference — otherwise an Alpine project
    // would fall through to the bare-Express branch below and be misdetected.
    if (dependencies["@imacrayon/alpine-ajax"] || htmlReferences(files, "alpine-ajax")) {
      return "alpine-express";
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

function pickEntryFilePath(
  files: Record<string, WorkspaceFile>,
  lessonType: WorkspaceLessonType,
): string {
  const playgroundRule = PLAYGROUND_LESSON_RULES.find((rule) => rule.lessonType === lessonType);
  if (playgroundRule) {
    if (files[playgroundRule.entryPath]) {
      return playgroundRule.entryPath;
    }

    const sourcePaths = Object.values(files)
      .filter(isWorkspaceTextFile)
      .map((file) => file.path)
      .filter((path) => playgroundRule.extensions.some((extension) => path.endsWith(extension)))
      .sort((left, right) => left.localeCompare(right));
    if (sourcePaths[0]) {
      return sourcePaths[0];
    }
  }

  for (const candidate of ENTRY_FILE_CANDIDATES) {
    if (files[candidate]) {
      return candidate;
    }
  }

  const firstTextFile = Object.values(files).find(isWorkspaceTextFile);

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
  content: WorkspaceFileContent,
  encoding: WorkspaceFileEncoding | undefined,
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
  return { ...metadata, content: typeof content === "string" ? content : "" };
}

/**
 * Parse an uploaded `.zip` into a {@link WorkspaceProject} that can be handed to
 * `loadProject`, exactly like selecting a starter template — only the contents
 * come from the user's own project rather than a built-in one. Everything runs
 * in the browser; nothing is uploaded to a server.
 */
export async function importWorkspaceProjectFromZip(file: File): Promise<WorkspaceProject> {
  let archive: Record<string, Uint8Array>;

  if (file.size > MAX_IMPORTED_ARCHIVE_BYTES) {
    throw new WorkspaceZipImportError("The zip file is larger than the 100 MB archive limit.");
  }

  try {
    let declaredBytes = 0;
    let entryCount = 0;
    archive = unzipSync(new Uint8Array(await file.arrayBuffer()), {
      filter: (entry) => {
        // Skip the artifacts the import throws away anyway BEFORE they are counted
        // or inflated. Counting them first spent the whole 50 MB budget on a
        // Finder-compressed project's node_modules and rejected an archive whose
        // actual source tree is a few hundred KB. `originalSize` is the declared
        // uncompressed size, so this also keeps the zip-bomb guard intact for the
        // entries that really are imported.
        //
        // `shouldIgnoreImportPath` is purely segment-based, so the raw zip name is
        // safe here; `parseWorkspacePath` is not — it throws on traversal entries,
        // and the catch below would turn that into "not a valid zip" instead of the
        // deliberate unsafe-path message. Traversal stays checked in the loop below.
        if (entry.name.endsWith("/") || shouldIgnoreImportPath(entry.name)) {
          return false;
        }
        entryCount += 1;
        declaredBytes += entry.originalSize;
        if (
          entryCount > MAX_IMPORTED_PROJECT_ENTRIES ||
          declaredBytes > MAX_IMPORTED_PROJECT_BYTES
        ) {
          throw new WorkspaceZipImportError("Archive exceeds the project import limits");
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof WorkspaceZipImportError) {
      throw new WorkspaceZipImportError(
        `This project exceeds the ${Math.round(
          MAX_IMPORTED_PROJECT_BYTES / (1024 * 1024),
        )} MB or ${MAX_IMPORTED_PROJECT_ENTRIES.toLocaleString()} file import limit.`,
      );
    }
    throw new WorkspaceZipImportError(
      "That file could not be read as a .zip archive. Please pick a valid zip file.",
    );
  }

  // Collect importable entries (skip directories and ignored artifacts) before
  // detecting a common wrapper folder so the strip decision sees only real files.
  const entries: Array<{ path: string; bytes: Uint8Array }> = [];

  for (const [name, bytes] of Object.entries(archive)) {
    if (name.endsWith("/")) {
      continue;
    }

    let normalizedPath: string;
    try {
      normalizedPath = parseWorkspacePath(name);
    } catch (error) {
      if (error instanceof WorkspacePathError) {
        throw new WorkspaceZipImportError(`The zip contains an unsafe path: "${name}".`);
      }
      throw error;
    }

    if (!shouldIgnoreImportPath(normalizedPath)) {
      entries.push({ path: normalizedPath, bytes });
    }
  }

  if (entries.length === 0) {
    throw new WorkspaceZipImportError(
      "The zip did not contain any importable files. Make sure it holds your project's source files.",
    );
  }

  const stripRootFolder = createRootFolderStripper(entries.map((entry) => entry.path));

  const files = new Map<string, WorkspaceFile>();
  let totalBytes = 0;

  for (const { path, bytes } of entries) {
    const workspacePath = parseWorkspacePath(stripRootFolder(path));

    if (files.has(workspacePath)) {
      throw new WorkspaceZipImportError(
        `Multiple zip entries resolve to the same workspace path: "${workspacePath}".`,
      );
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
      const descriptor = await registerWorkspaceAsset(bytes, {
        mimeType: getWorkspaceFileMimeType(workspacePath),
      });
      files.set(workspacePath, createWorkspaceFile(workspacePath, descriptor, "asset"));
    } else {
      files.set(workspacePath, createWorkspaceFile(workspacePath, strFromU8(bytes), undefined));
    }
  }

  for (const path of files.keys()) {
    const segments = path.split("/");
    segments.pop();

    while (segments.length > 0) {
      const parentPath = segments.join("/");
      if (files.has(parentPath)) {
        throw new WorkspaceZipImportError(
          `The zip uses "${parentPath}" as both a file and a directory.`,
        );
      }
      segments.pop();
    }
  }

  const fileRecord = Object.fromEntries(files);

  const name = deriveProjectNameFromFileName(file.name);
  const lessonType = detectImportedLessonType(fileRecord);

  return {
    id: toProjectId(name),
    name,
    lessonType,
    entryFilePath: pickEntryFilePath(fileRecord, lessonType),
    folders: collectWorkspaceFolders(Object.keys(fileRecord)),
    files: fileRecord,
  };
}
