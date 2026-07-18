export type WorkspaceFileEncoding = "utf-8" | "asset";

export interface WorkspaceAssetDescriptor {
  kind: "asset";
  assetId: string;
  mimeType: string;
  size: number;
}

/** Raw SCR3 payload carried outside workspace project snapshots. */
export interface WorkspaceRecordingAsset {
  descriptor: WorkspaceAssetDescriptor;
  bytes: Uint8Array;
}

interface WorkspaceFileMetadata {
  path: string;
  name: string;
  language: string;
}

export interface WorkspaceTextFile extends WorkspaceFileMetadata {
  content: string;
  encoding?: "utf-8";
}

export interface WorkspaceAssetFile extends WorkspaceFileMetadata {
  content: WorkspaceAssetDescriptor;
  encoding: "asset";
}

/** Read-only migration shape for projects saved before asset descriptors. */
export interface LegacyWorkspaceBinaryFile extends WorkspaceFileMetadata {
  content: string;
  encoding: "base64";
}

export type WorkspaceFile = WorkspaceTextFile | WorkspaceAssetFile | LegacyWorkspaceBinaryFile;
export type WorkspaceFileContent = string | WorkspaceAssetDescriptor;

export function isWorkspaceAssetDescriptor(value: unknown): value is WorkspaceAssetDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const descriptor = value as Partial<WorkspaceAssetDescriptor>;
  return (
    descriptor.kind === "asset" &&
    typeof descriptor.assetId === "string" &&
    descriptor.assetId.length > 0 &&
    typeof descriptor.mimeType === "string" &&
    descriptor.mimeType.length > 0 &&
    typeof descriptor.size === "number" &&
    Number.isSafeInteger(descriptor.size) &&
    descriptor.size >= 0
  );
}

export function isWorkspaceAssetFile(file: WorkspaceFile): file is WorkspaceAssetFile {
  return file.encoding === "asset" && isWorkspaceAssetDescriptor(file.content);
}

export function isLegacyWorkspaceBinaryFile(
  file: WorkspaceFile,
): file is LegacyWorkspaceBinaryFile {
  return file.encoding === "base64";
}

export function isWorkspaceTextFile(file: WorkspaceFile): file is WorkspaceTextFile {
  return file.encoding === undefined || file.encoding === "utf-8";
}

/** Lightweight file metadata used by tree/sidebar consumers. */
export interface WorkspaceTreeFile extends WorkspaceFileMetadata {
  encoding?: WorkspaceFile["encoding"];
}

export type WorkspaceLessonType =
  | "html-css"
  | "react"
  | "vue"
  | "solid"
  | "svelte"
  | "htmx-express"
  | "alpine-express"
  | "express-ts"
  | "go";

/**
 * Every browser-runtime lesson type is served by its own dev server inside the
 * WebContainer: the Vite-based SPAs (react, vue, solid, svelte) and html-css
 * run a Vite dev server, while htmx-express, alpine-express, and express-ts run
 * an Express server. Go is deliberately excluded because it uses the selective
 * Playground execution path below.
 */
const WEB_CONTAINER_LESSON_TYPES: ReadonlySet<WorkspaceLessonType> = new Set([
  "html-css",
  "react",
  "vue",
  "solid",
  "svelte",
  "htmx-express",
  "alpine-express",
  "express-ts",
]);

export function lessonRunsInWebContainer(lessonType: WorkspaceLessonType): boolean {
  return WEB_CONTAINER_LESSON_TYPES.has(lessonType);
}

/**
 * Which backend executes code for a lesson. `go` lessons compile through the
 * Go Playground proxy on the main Worker; everything else keeps the
 * WebContainer runtime. Derived from `lessonType` — never persisted as a
 * second field (see docs/go-lessons-selective-runtime-plan.md §6).
 */
export type WorkspaceExecutionKind = "webcontainer" | "go-playground";

export function executionKindForLessonType(
  lessonType: WorkspaceLessonType,
): WorkspaceExecutionKind {
  return lessonType === "go" ? "go-playground" : "webcontainer";
}

// Capability predicates stay separate from the execution kind so a Go lesson
// can expose Run and console output without exposing Terminal or Preview.
export function lessonSupportsTerminal(lessonType: WorkspaceLessonType): boolean {
  return lessonRunsInWebContainer(lessonType);
}

export function lessonSupportsPreview(lessonType: WorkspaceLessonType): boolean {
  return lessonRunsInWebContainer(lessonType);
}

export function lessonSupportsCodeRun(lessonType: WorkspaceLessonType): boolean {
  return lessonType === "go" || lessonRunsInWebContainer(lessonType);
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
  /** File-sidebar width change since the previous recorded workspace event. */
  sidebarWidthDelta?: number;
  /** Docked-preview width change since the previous recorded workspace event. */
  previewDockWidthDelta?: number;
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

    const contentEqual =
      typeof leftFile.content === "string" && typeof rightFile.content === "string"
        ? leftFile.content === rightFile.content
        : isWorkspaceAssetDescriptor(leftFile.content) &&
          isWorkspaceAssetDescriptor(rightFile.content) &&
          leftFile.content.assetId === rightFile.content.assetId &&
          leftFile.content.mimeType === rightFile.content.mimeType &&
          leftFile.content.size === rightFile.content.size;

    return (
      leftFile.path === rightFile.path &&
      leftFile.name === rightFile.name &&
      leftFile.language === rightFile.language &&
      contentEqual &&
      (leftFile.encoding ?? "utf-8") === (rightFile.encoding ?? "utf-8")
    );
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function areWorkspaceWidthDeltasEqual(
  left: WorkspaceRecordingSnapshot,
  right: WorkspaceRecordingSnapshot,
): boolean {
  const leftSidebar = isFiniteNumber(left.sidebarWidthDelta) ? left.sidebarWidthDelta : 0;
  const rightSidebar = isFiniteNumber(right.sidebarWidthDelta) ? right.sidebarWidthDelta : 0;
  const leftPreview = isFiniteNumber(left.previewDockWidthDelta) ? left.previewDockWidthDelta : 0;
  const rightPreview = isFiniteNumber(right.previewDockWidthDelta)
    ? right.previewDockWidthDelta
    : 0;

  return leftSidebar === rightSidebar && leftPreview === rightPreview;
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
    areWorkspaceWidthDeltasEqual(left, right) &&
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

export interface WorkspaceWidthDeltas {
  sidebarWidthDelta?: number;
  previewDockWidthDelta?: number;
}

/**
 * Fold panel-resize offsets into a workspace snapshot. Both the file-sidebar and
 * the docked-preview record their resizes as per-event deltas (not absolute
 * widths) so playback applies the same offset to whatever width the viewer
 * currently has.
 */
export function toWorkspaceDeltaSnapshot(
  snapshot: WorkspaceRecordingSnapshot,
  deltas: WorkspaceWidthDeltas,
): WorkspaceRecordingSnapshot {
  const next: WorkspaceRecordingSnapshot = { ...snapshot };
  let changed = false;

  if (isFiniteNumber(deltas.sidebarWidthDelta)) {
    next.sidebarWidthDelta = deltas.sidebarWidthDelta;
    changed = true;
  }

  if (isFiniteNumber(deltas.previewDockWidthDelta)) {
    next.previewDockWidthDelta = deltas.previewDockWidthDelta;
    changed = true;
  }

  return changed ? next : snapshot;
}

export const DEFAULT_WORKSPACE_ENTRY_PATH = "index.html";
export const DEFAULT_WORKSPACE_APP_PATH = "src/App.tsx";

const RESERVED_WORKSPACE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function containsWorkspacePathControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export class WorkspacePathError extends Error {
  readonly input: string;

  constructor(message: string, input: string) {
    super(message);
    this.name = "WorkspacePathError";
    this.input = input;
  }
}

interface ParseWorkspacePathOptions {
  allowEmpty?: boolean;
}

/**
 * Parse a user/import/runtime supplied path into one canonical workspace-relative path.
 *
 * Leading separators are treated as workspace-root-relative for backwards compatibility.
 * Dot segments are resolved, while traversal above the workspace root, control characters,
 * and names that are unsafe as JavaScript record keys are rejected.
 */
export function parseWorkspacePath(
  path: string,
  { allowEmpty = false }: ParseWorkspacePathOptions = {},
): string {
  if (typeof path !== "string") {
    throw new WorkspacePathError("Workspace path must be a string", String(path));
  }

  const input = path;
  const normalizedSeparators = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");

  // Repeated separators inside a path are canonicalized, but a trailing
  // separator would otherwise turn an empty terminal filename into its parent
  // directory (for example, "src/App.tsx/" -> "src/App.tsx"). Keep the empty
  // workspace root as the sole exception for callers that explicitly allow it.
  if (normalizedSeparators.length > 0 && normalizedSeparators.endsWith("/")) {
    throw new WorkspacePathError("Workspace path has an empty terminal name", input);
  }
  const segments: string[] = [];

  for (const segment of normalizedSeparators.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (segments.length === 0) {
        throw new WorkspacePathError("Workspace path escapes the project root", input);
      }
      segments.pop();
      continue;
    }

    if (containsWorkspacePathControlCharacter(segment)) {
      throw new WorkspacePathError("Workspace path contains a control character", input);
    }

    if (RESERVED_WORKSPACE_PATH_SEGMENTS.has(segment)) {
      throw new WorkspacePathError(`Workspace path uses the reserved name "${segment}"`, input);
    }

    segments.push(segment);
  }

  const normalizedPath = segments.join("/");

  if (!normalizedPath && !allowEmpty) {
    throw new WorkspacePathError("Workspace path cannot be empty", input);
  }

  return normalizedPath;
}

export function tryParseWorkspacePath(
  path: string,
  options: ParseWorkspacePathOptions = {},
): string | null {
  try {
    return parseWorkspacePath(path, options);
  } catch {
    return null;
  }
}

export function normalizeWorkspacePath(path: string): string {
  return tryParseWorkspacePath(path, { allowEmpty: true }) ?? "";
}

export function normalizeWorkspaceFolderPath(path: string): string {
  return normalizeWorkspacePath(path);
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

  if (!normalizedName) {
    return "";
  }

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

  if (
    normalizedPath.endsWith(".tsx") ||
    normalizedPath.endsWith(".ts") ||
    normalizedPath.endsWith(".mts") ||
    normalizedPath.endsWith(".cts")
  ) {
    return "typescript";
  }

  if (
    normalizedPath.endsWith(".jsx") ||
    normalizedPath.endsWith(".js") ||
    normalizedPath.endsWith(".mjs") ||
    normalizedPath.endsWith(".cjs")
  ) {
    return "javascript";
  }

  if (normalizedPath.endsWith(".json")) {
    return "json";
  }

  if (normalizedPath.endsWith(".go")) {
    return "go";
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
