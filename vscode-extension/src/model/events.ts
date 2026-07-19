import type { CheckpointId, DocumentId, GroupId, RootId, SessionId, SurfaceId, TabId } from "./ids";

// Core envelope (plan §7.2). `seq` starts at 0 and increases by exactly 1;
// `tUs` is session-relative microseconds, nondecreasing; `seq` breaks ties.
export type EventEnvelope<TType extends string, TPayload> = {
  seq: number;
  tUs: number;
  type: TType;
  payload: TPayload;
};

export type UriSchemeClass = "file" | "untitled" | "remote" | "virtual" | "other";
export type EolMode = "LF" | "CRLF";
export type PatchReason = "undo" | "redo" | "unknown";
export type SelectionKind = "mouse" | "keyboard" | "command" | "unknown";
export type CheckpointReason = "enrollment" | "resume" | "mismatch" | "interval" | "limit" | "stop";

export type WorkspaceRootDescriptor = {
  rootId: RootId;
  name: string;
  ordinal: number;
};

// Privacy contract (plan §7.5): no absolute paths, no query strings, no
// authority, no home directories.
export type DocumentDescriptor = {
  documentId: DocumentId;
  rootId: RootId | null;
  logicalPath: string;
  displayName: string;
  schemeClass: UriSchemeClass;
  languageId: string;
  eol: EolMode;
  initialVersion: number;
  initialCheckpointId: CheckpointId;
  byteLength: number;
  sha256: string;
};

export type ContentChange = {
  rangeOffsetUtf16: number;
  rangeLengthUtf16: number;
  text: string;
};

export type DocumentPatchPayload = {
  documentId: DocumentId;
  beforeVersion: number;
  afterVersion: number;
  reason: PatchReason;
  changes: ContentChange[];
  beforeHash: string;
  afterHash: string;
  eolBefore: EolMode;
  eolAfter: EolMode;
};

export type CheckpointMeta = {
  checkpointId: CheckpointId;
  documentId: DocumentId;
  reason: CheckpointReason;
  version: number;
  eol: EolMode;
  byteLength: number;
  sha256: string;
};

export type SelectionRange = {
  anchorOffsetUtf16: number;
  activeOffsetUtf16: number;
};

export type VisibleLineRange = {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
};

export type TabKind =
  | "text"
  | "textDiff"
  | "notebook"
  | "notebookDiff"
  | "custom"
  | "webview"
  | "terminal"
  | "other";

export type TabDescriptor = {
  tabId: TabId;
  kind: TabKind;
  // Present only for supported text tabs whose document is enrolled.
  documentId: DocumentId | null;
  label: string;
  isActive: boolean;
  isPinned: boolean;
  isPreview: boolean;
};

export type GroupSnapshot = {
  groupId: GroupId;
  viewColumn: number;
  isActive: boolean;
  activeTabId: TabId | null;
  tabs: TabDescriptor[];
};

export type TopologySnapshotPayload = {
  groups: GroupSnapshot[];
  activeGroupId: GroupId | null;
  // The public API exposes no split geometry; playback reconstructs a
  // logical layout (plan §7.8, §10.6).
  fidelity: "reconstructed-no-geometry";
  discontinuity: boolean;
};

export type SessionStartedPayload = {
  sessionId: SessionId;
  extensionVersion: string;
  vscodeVersion: string;
  platform: string;
  architecture: string;
};

export type SessionEvent =
  | EventEnvelope<"session.started", SessionStartedPayload>
  | EventEnvelope<"roots.snapshot", { roots: WorkspaceRootDescriptor[] }>
  | EventEnvelope<"document.enrolled", { descriptor: DocumentDescriptor }>
  | EventEnvelope<"document.patch", DocumentPatchPayload>
  | EventEnvelope<"document.checkpoint", CheckpointMeta>
  | EventEnvelope<"document.languageChanged", { documentId: DocumentId; languageId: string }>
  | EventEnvelope<"document.eolChanged", { documentId: DocumentId; eol: EolMode; version: number }>
  | EventEnvelope<"document.saved", { documentId: DocumentId; version: number }>
  | EventEnvelope<"document.closed", { documentId: DocumentId }>
  | EventEnvelope<"document.resumed", { documentId: DocumentId; version: number }>
  | EventEnvelope<
      "surface.opened",
      {
        surfaceId: SurfaceId;
        documentId: DocumentId;
        groupId: GroupId | null;
        viewColumn: number | null;
        selections: SelectionRange[];
        visibleRanges: VisibleLineRange[];
        isActive: boolean;
      }
    >
  | EventEnvelope<"surface.closed", { surfaceId: SurfaceId }>
  | EventEnvelope<"surface.focused", { surfaceId: SurfaceId }>
  | EventEnvelope<
      "surface.selectionChanged",
      {
        surfaceId: SurfaceId;
        documentId: DocumentId;
        documentVersion: number;
        kind: SelectionKind;
        selections: SelectionRange[];
      }
    >
  | EventEnvelope<
      "surface.viewportChanged",
      {
        surfaceId: SurfaceId;
        documentId: DocumentId;
        documentVersion: number;
        visibleRanges: VisibleLineRange[];
      }
    >
  | EventEnvelope<"topology.snapshot", TopologySnapshotPayload>
  | EventEnvelope<"window.focusChanged", { focused: boolean }>
  | EventEnvelope<"capability.unsupportedSurface", { tabId: TabId; kind: TabKind; label: string }>
  | EventEnvelope<"capture.overload", { queuedEvents: number; note: string }>
  | EventEnvelope<
      "capture.shadowMismatch",
      {
        documentId: DocumentId;
        expectedSha256: string;
        observedSha256: string;
        version: number;
      }
    >
  | EventEnvelope<"marker", { label: string }>;

export type SessionEventType = SessionEvent["type"];
