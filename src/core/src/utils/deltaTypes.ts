import type * as monaco from "monaco-editor";
import type { CursorRecordingEvent, MouseCursorPosition, EditorFrame } from "../types";
import type {
  PreviewDomPatchBatch,
  PreviewInitialDocument,
  SlidePreviewState,
  PreviewState,
} from "../slides";
import type { RuntimeRecordingEvent } from "../../../types/runtime";
import type { WorkspaceRecordingEvent } from "../../../types/workspace";
import type { ChatRecordingEvent } from "../../../types/chat";

// ============================================================================
// Delta Compression Types
// ============================================================================

/**
 * Delta for content changes — an opaque diff-match-patch (Myers) delta that
 * transforms the previous frame's content into this frame's content. Unlike the
 * former prefix/suffix model it stays compact across multiple, non-contiguous
 * edits. Produced/consumed only by createContentDelta/applyContentDelta, which
 * round-trip it through the Rust WASM codec; msgpack stores it as a
 * binary blob.
 */
export interface ContentDelta {
  delta: Uint8Array;
}

/**
 * Delta for cursor/caret position changes
 */
export interface PositionDelta {
  lineDelta: number;
  columnDelta: number;
}

/**
 * Delta for selection changes
 */
export interface SelectionDelta {
  startLineDelta?: number;
  startColumnDelta?: number;
  endLineDelta?: number;
  endColumnDelta?: number;
  selectionStartLineDelta?: number;
  selectionStartColumnDelta?: number;
  positionLineDelta?: number;
  positionColumnDelta?: number;
}

/**
 * Delta form of previewState, emitted when previewState changed but its
 * `content` — the full static-preview HTML, tens of KB — did not. Scroll ticks
 * mutate previewState at animation-frame rate, so copying it whole would embed
 * the unchanged content per tick; this form carries everything else and
 * `applyFrameDelta` restores content from the base frame, keeping delta frames
 * genuinely incremental.
 */
export interface PreviewStateContentUnchanged extends Omit<PreviewState, "content"> {
  contentUnchanged: true;
}

/**
 * Delta form of previewState for frames where the preview content itself
 * changed: successive static-preview HTML versions differ by keystrokes (live
 * editing re-renders the preview per edit), so like editor content they are
 * stored as a dmp patch against the base frame's content rather than another
 * full copy. `applyFrameDelta` rebuilds the content along the base chain.
 */
export interface PreviewStateContentPatched extends Omit<PreviewState, "content"> {
  contentDelta: ContentDelta;
}

/**
 * A frame delta - stores only changes from previous frame
 * Used for frames between keyframes to reduce storage
 */
export interface FrameDelta {
  timestamp: number;
  /** If true, this is a keyframe with full state */
  isKeyframe: false;
  /** Content delta (omitted if content unchanged) */
  contentDelta?: ContentDelta;
  /** Position delta (omitted if position unchanged) */
  positionDelta?: PositionDelta;
  /** Selection delta (omitted if selection unchanged) */
  selectionDelta?: SelectionDelta;
  /** View state (only included if changed) */
  viewState?: monaco.editor.ICodeEditorViewState | null;
  /** Mouse cursor (only included if changed) */
  mouseCursor?: MouseCursorPosition;
  /** Slide state (only included if changed) */
  slideState?: SlidePreviewState;
  /** Current slide index (only included if changed) */
  currentSlideIndex?: number;
  /**
   * Preview state (only included if changed; the content-unchanged form omits
   * the embedded preview HTML and the content-patched form carries a dmp patch
   * — both are resolved against the base frame on apply)
   */
  previewState?: PreviewState | PreviewStateContentUnchanged | PreviewStateContentPatched;
}

/**
 * A keyframe - contains full state for seeking
 */
export interface Keyframe extends EditorFrame {
  /** Marks this as a keyframe */
  isKeyframe: true;
}

/**
 * Union type for frames in a delta recording
 */
export type DeltaFrame = Keyframe | FrameDelta;

/**
 * Recording format with delta compression
 */
export interface DeltaRecording {
  /** Recording schema version using delta-compressed frames. */
  version: 4;
  id: string;
  name: string;
  /** Number of frames between keyframes */
  keyframeInterval: number;
  /** Compressed frames (keyframes + deltas) */
  frames: DeltaFrame[];
  slideEvents?: import("../slides").SlideEvent[];
  previewEvents?: import("../slides").PreviewEvent[];
  previewInitialDocuments?: PreviewInitialDocument[];
  previewPatchBatches?: PreviewDomPatchBatch[];
  workspaceEvents?: WorkspaceRecordingEvent[];
  runtimeEvents?: RuntimeRecordingEvent[];
  cursorEvents?: CursorRecordingEvent[];
  chatEvents?: ChatRecordingEvent[];
  slides?: Array<{
    id: string;
    imageUrl: string;
    name?: string;
    order: number;
  }>;
  audioBlob?: Blob | import("../types").AudioPlaceholder;
  audioSource?: import("../types").RecordingAudioSource;
  duration: number;
  createdAt: number;
}

/**
 * Configuration for delta compression
 */
export const DELTA_CONFIG = {
  /** Number of frames between keyframes (at 60fps, 120 = 2 seconds) */
  KEYFRAME_INTERVAL: 120,
  /** Format version identifier */
  VERSION: 4 as const,
} as const;

/**
 * Type guard to check if a frame is a keyframe
 */
export function isKeyframe(frame: DeltaFrame): frame is Keyframe {
  return "isKeyframe" in frame && frame.isKeyframe === true;
}

/**
 * Type guard to check if a frame is a delta
 */
export function isDelta(frame: DeltaFrame): frame is FrameDelta {
  return "isKeyframe" in frame && frame.isKeyframe === false;
}

/**
 * Type guard to check if a recording uses delta compression
 */
export function isDeltaRecording(recording: unknown): recording is DeltaRecording {
  return (
    typeof recording === "object" &&
    recording !== null &&
    "version" in recording &&
    (recording as DeltaRecording).version === 4
  );
}
