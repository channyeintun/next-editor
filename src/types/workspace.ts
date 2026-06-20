export type WorkspaceFileEncoding = "utf-8" | "base64";

export interface WorkspaceFile {
  path: string;
  name: string;
  language: string;
  content: string;
  /**
   * How `content` is encoded. Text files use "utf-8" (also the default when the
   * field is absent). Binary assets — images, video, audio, fonts, … — store
   * their bytes base64-encoded in `content` so the whole workspace stays
   * JSON-serializable for localStorage persistence and recordings, and so it
   * can travel through the same string-based file pipeline as text.
   */
  encoding?: WorkspaceFileEncoding;
}

export type WorkspaceLessonType =
  | "html-css"
  | "react"
  | "vue"
  | "solid"
  | "svelte"
  | "htmx-express";

/**
 * Every lesson type is served by its own dev server inside the WebContainer:
 * the Vite-based SPAs (react, vue, solid, svelte) and html-css run a Vite dev
 * server, while htmx-express runs an Express server. This predicate keeps the
 * runtime/preview code from special-casing individual lesson types, and is the
 * single place to update when new templates are added.
 */
const WEB_CONTAINER_LESSON_TYPES: ReadonlySet<WorkspaceLessonType> = new Set([
  "html-css",
  "react",
  "vue",
  "solid",
  "svelte",
  "htmx-express",
]);

export function lessonRunsInWebContainer(lessonType: WorkspaceLessonType): boolean {
  return WEB_CONTAINER_LESSON_TYPES.has(lessonType);
}

export interface WorkspaceProject {
  id: string;
  name: string;
  lessonType: WorkspaceLessonType;
  entryFilePath: string;
  folders: string[];
  files: Record<string, WorkspaceFile>;
}

export interface WorkspaceRecordingSnapshot {
  project: WorkspaceProject;
  activeFilePath: string;
  collapsedFolders?: string[];
  sidebarScrollTop?: number;
  /** Width change since the previous recorded workspace event. */
  sidebarWidthDelta?: number;
}

export interface WorkspaceRecordingEvent {
  timestamp: number;
  snapshot: WorkspaceRecordingSnapshot;
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function areWorkspaceFilesEqual(
  left: Record<string, WorkspaceFile>,
  right: Record<string, WorkspaceFile>,
): boolean {
  const leftPaths = Object.keys(left).sort((firstPath, secondPath) =>
    firstPath.localeCompare(secondPath),
  );
  const rightPaths = Object.keys(right).sort((firstPath, secondPath) =>
    firstPath.localeCompare(secondPath),
  );

  if (!areStringArraysEqual(leftPaths, rightPaths)) {
    return false;
  }

  return leftPaths.every((path) => {
    const leftFile = left[path];
    const rightFile = right[path];

    return (
      leftFile.path === rightFile.path &&
      leftFile.name === rightFile.name &&
      leftFile.language === rightFile.language &&
      leftFile.content === rightFile.content &&
      (leftFile.encoding ?? "utf-8") === (rightFile.encoding ?? "utf-8")
    );
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function areWorkspaceSidebarDeltasEqual(
  left: WorkspaceRecordingSnapshot,
  right: WorkspaceRecordingSnapshot,
): boolean {
  const leftDelta = isFiniteNumber(left.sidebarWidthDelta) ? left.sidebarWidthDelta : 0;
  const rightDelta = isFiniteNumber(right.sidebarWidthDelta) ? right.sidebarWidthDelta : 0;

  return leftDelta === rightDelta;
}

export function areWorkspaceProjectsEqual(
  left: WorkspaceProject,
  right: WorkspaceProject,
): boolean {
  if (left === right) {
    return true;
  }

  return (
    left.id === right.id &&
    left.name === right.name &&
    left.lessonType === right.lessonType &&
    left.entryFilePath === right.entryFilePath &&
    areStringArraysEqual(left.folders, right.folders) &&
    areWorkspaceFilesEqual(left.files, right.files)
  );
}

export function areWorkspaceSnapshotsEqual(
  left: WorkspaceRecordingSnapshot,
  right: WorkspaceRecordingSnapshot,
): boolean {
  if (left === right) {
    return true;
  }

  return (
    left.activeFilePath === right.activeFilePath &&
    (left.sidebarScrollTop ?? 0) === (right.sidebarScrollTop ?? 0) &&
    areWorkspaceSidebarDeltasEqual(left, right) &&
    areStringArraysEqual(left.collapsedFolders ?? [], right.collapsedFolders ?? []) &&
    areWorkspaceProjectsEqual(left.project, right.project)
  );
}

export function toSidebarWidthDeltaSnapshot(
  snapshot: WorkspaceRecordingSnapshot,
  sidebarWidthDelta: number | undefined,
): WorkspaceRecordingSnapshot {
  if (!isFiniteNumber(sidebarWidthDelta)) {
    return snapshot;
  }

  return {
    ...snapshot,
    sidebarWidthDelta,
  };
}

export const DEFAULT_WORKSPACE_ENTRY_PATH = "index.html";
export const DEFAULT_WORKSPACE_APP_PATH = "src/App.tsx";

export function normalizeWorkspacePath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\\/g, "/").replace(/\/+/g, "/").trim();
}

export function normalizeWorkspaceFolderPath(path: string): string {
  return normalizeWorkspacePath(path).replace(/\/+$/, "");
}

export function getWorkspaceBaseName(path: string): string {
  const normalizedPath = normalizeWorkspacePath(path);
  const segments = normalizedPath.split("/");
  return segments[segments.length - 1] || normalizedPath;
}

export function getParentWorkspacePath(path: string): string {
  const normalizedPath = normalizeWorkspacePath(path);
  const segments = normalizedPath.split("/");
  segments.pop();
  return segments.join("/");
}

export function joinWorkspacePath(parentPath: string, name: string): string {
  const normalizedParentPath = normalizeWorkspaceFolderPath(parentPath);
  const normalizedName = normalizeWorkspacePath(name);

  if (!normalizedParentPath) {
    return normalizedName;
  }

  return normalizeWorkspacePath(`${normalizedParentPath}/${normalizedName}`);
}

export function collectWorkspaceFolders(
  filePaths: string[],
  extraFolders: string[] = [],
): string[] {
  const folders = new Set<string>();

  const addFolderPath = (folderPath: string) => {
    let currentPath = normalizeWorkspaceFolderPath(folderPath);

    while (currentPath) {
      folders.add(currentPath);
      currentPath = getParentWorkspacePath(currentPath);
    }
  };

  for (const folderPath of extraFolders) {
    addFolderPath(folderPath);
  }

  for (const filePath of filePaths) {
    addFolderPath(getParentWorkspacePath(filePath));
  }

  return Array.from(folders).sort((left, right) => left.localeCompare(right));
}

export function inferLanguageFromPath(path: string): string {
  const normalizedPath = normalizeWorkspacePath(path).toLowerCase();

  if (normalizedPath.endsWith(".tsx") || normalizedPath.endsWith(".ts")) {
    return "typescript";
  }

  if (normalizedPath.endsWith(".jsx") || normalizedPath.endsWith(".js")) {
    return "javascript";
  }

  if (normalizedPath.endsWith(".json")) {
    return "json";
  }

  if (normalizedPath.endsWith(".css")) {
    return "css";
  }

  if (normalizedPath.endsWith(".md")) {
    return "markdown";
  }

  if (normalizedPath.endsWith(".html")) {
    return "html";
  }

  // Monaco has no dedicated Vue/Svelte single-file-component mode; HTML gives
  // the closest highlighting for their template-heavy markup.
  if (normalizedPath.endsWith(".vue") || normalizedPath.endsWith(".svelte")) {
    return "html";
  }

  return "plaintext";
}

export function getWorkspaceFileExtension(path: string): string {
  const name = getWorkspaceBaseName(normalizeWorkspacePath(path)).toLowerCase();
  const dotIndex = name.lastIndexOf(".");

  return dotIndex > 0 ? name.slice(dotIndex + 1) : "";
}

// Extensions whose contents are not editable text and must be stored as bytes.
// SVG is intentionally absent: it is XML and stays editable as text.
const BINARY_WORKSPACE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Images
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
  "tiff",
  "tif",
  // Video
  "mp4",
  "webm",
  "mov",
  "m4v",
  "avi",
  "mkv",
  "ogv",
  // Audio
  "mp3",
  "wav",
  "ogg",
  "oga",
  "m4a",
  "aac",
  "flac",
  // Fonts
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  // Other binary assets
  "pdf",
  "wasm",
  "zip",
  "gz",
  "tar",
  "bz2",
]);

const WORKSPACE_FILE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  tiff: "image/tiff",
  tif: "image/tiff",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
  wasm: "application/wasm",
};

/** True when a path points at a non-text asset that must be stored as bytes. */
export function isBinaryWorkspacePath(path: string): boolean {
  return BINARY_WORKSPACE_FILE_EXTENSIONS.has(getWorkspaceFileExtension(path));
}

export function getWorkspaceFileMimeType(path: string): string {
  return WORKSPACE_FILE_MIME_TYPES[getWorkspaceFileExtension(path)] ?? "application/octet-stream";
}

export type WorkspaceMediaKind = "image" | "video" | "audio" | "other";

export function getWorkspaceMediaKind(path: string): WorkspaceMediaKind {
  const mimeType = getWorkspaceFileMimeType(path);

  if (mimeType.startsWith("image/")) {
    return "image";
  }

  if (mimeType.startsWith("video/")) {
    return "video";
  }

  if (mimeType.startsWith("audio/")) {
    return "audio";
  }

  return "other";
}

/** Encode raw bytes as base64 in chunks so large assets don't overflow the stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

/** Estimate the decoded byte length of base64 content without decoding it. */
export function approximateBase64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;

  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/**
 * Resolve a non-colliding workspace path by appending `-1`, `-2`, … before the
 * extension. Used when importing assets so re-uploading never clobbers a file.
 */
export function getUniqueWorkspacePath(
  desiredPath: string,
  isTaken: (path: string) => boolean,
): string {
  const normalizedPath = normalizeWorkspacePath(desiredPath);

  if (!isTaken(normalizedPath)) {
    return normalizedPath;
  }

  const parentPath = getParentWorkspacePath(normalizedPath);
  const baseName = getWorkspaceBaseName(normalizedPath);
  const dotIndex = baseName.lastIndexOf(".");
  const stem = dotIndex > 0 ? baseName.slice(0, dotIndex) : baseName;
  const extension = dotIndex > 0 ? baseName.slice(dotIndex) : "";

  let counter = 1;
  let candidate = joinWorkspacePath(parentPath, `${stem}-${counter}${extension}`);

  while (isTaken(candidate)) {
    counter += 1;
    candidate = joinWorkspacePath(parentPath, `${stem}-${counter}${extension}`);
  }

  return candidate;
}
