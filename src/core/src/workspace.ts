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

/**
 * Every lesson type a project can carry. The picker labels and the execution and
 * capability rules for each live with the lesson catalog in src/types/lessonTypes.ts.
 */
export type WorkspaceLessonType =
  | "html-css"
  | "react"
  | "vue"
  | "solid"
  | "svelte"
  | "htmx-express"
  | "alpine-express"
  | "express-ts"
  | "javascript"
  | "typescript"
  | "go"
  | "kotlin"
  | "python"
  | "rust"
  | "zig"
  | "haskell"
  | "kite"
  | "kite-web"
  | "asm";

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
  /**
   * File explorer shut for this lesson.
   *
   * Only ever set on a recording's *initial* snapshot, and only by a lesson
   * that asks for it (a one-file lesson spends the tree's width on nothing).
   * Absent — which is every recording made before this and every lesson that
   * does not ask — leaves the viewer's own preference exactly as it was. The
   * toggle keeps working mid-replay either way: this decides where playback
   * starts, not what the viewer is allowed to do.
   */
  sidebarCollapsed?: boolean;
  /** File-sidebar width change since the previous recorded workspace event. */
  sidebarWidthDelta?: number;
  /** Docked-preview width change since the previous recorded workspace event. */
  previewDockWidthDelta?: number;
}

export interface WorkspaceRecordingEvent {
  timestamp: number;
  snapshot: WorkspaceRecordingSnapshot;
}

export function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

export function areWorkspaceAssetDescriptorsEqual(
  left: WorkspaceAssetDescriptor,
  right: WorkspaceAssetDescriptor,
): boolean {
  return (
    left.assetId === right.assetId && left.mimeType === right.mimeType && left.size === right.size
  );
}

/** One file's metadata, content and encoding; a missing encoding means "utf-8". */
export function areWorkspaceFilesEqual(left: WorkspaceFile, right: WorkspaceFile): boolean {
  if (left === right) {
    return true;
  }

  const contentEqual =
    typeof left.content === "string" && typeof right.content === "string"
      ? left.content === right.content
      : isWorkspaceAssetDescriptor(left.content) &&
        isWorkspaceAssetDescriptor(right.content) &&
        areWorkspaceAssetDescriptorsEqual(left.content, right.content);

  return (
    left.path === right.path &&
    left.name === right.name &&
    left.language === right.language &&
    contentEqual &&
    (left.encoding ?? "utf-8") === (right.encoding ?? "utf-8")
  );
}

/**
 * Record keys are unique, so equal key counts plus every left key present on the
 * right is the same key set; no sort needed. This runs on every runtime reverse
 * sync and every replayed workspace event.
 */
function areWorkspaceFileRecordsEqual(
  left: Record<string, WorkspaceFile>,
  right: Record<string, WorkspaceFile>,
): boolean {
  if (left === right) {
    return true;
  }

  const leftPaths = Object.keys(left);

  if (leftPaths.length !== Object.keys(right).length) {
    return false;
  }

  return leftPaths.every(
    (path) => Object.hasOwn(right, path) && areWorkspaceFilesEqual(left[path], right[path]),
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * A sidebar or preview-dock width delta that changes something: a finite,
 * non-zero number. Recording keeps every snapshot that carries one, and replay
 * applies only those.
 */
export function isNonZeroWidthDelta(value: unknown): value is number {
  return isFiniteNumber(value) && value !== 0;
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
    areWorkspaceFileRecordsEqual(left.files, right.files)
  );
}

/**
 * `sidebarCollapsed` is deliberately not compared. It says where playback
 * *starts* the file explorer, and only the initial snapshot is ever read for
 * it; a viewer toggling the tree mid-recording is their business and must not
 * become a recorded workspace event.
 */
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
