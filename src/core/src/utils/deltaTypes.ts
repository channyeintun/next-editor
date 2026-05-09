import type * as monaco from "monaco-editor";
import type { MouseCursorPosition, EditorFrame } from "../types";
import type { SlidePreviewState, PreviewState } from "../slides";
import type { RuntimeRecordingEvent } from "../../../types/runtime";
import type { WorkspaceRecordingEvent } from "../../../types/workspace";

// ============================================================================
// Delta Compression Types
// ============================================================================

/**
 * Delta for content changes - stores only what changed
 */
export interface ContentDelta {
  /** Number of bytes to keep from the start of previous content */
  prefixLen: number;
  /** Number of bytes to keep from the end of previous content */
  suffixLen: number;
  /** New content to insert between prefix and suffix */
  insert: string;
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
  /** Preview state (only included if changed) */
  previewState?: PreviewState;
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
  version: 2 | 3;
  id: string;
  name: string;
  /** Number of frames between keyframes */
  keyframeInterval: number;
  /** Compressed frames (keyframes + deltas) */
  frames: DeltaFrame[];
  slideEvents?: import("../slides").SlideEvent[];
  previewEvents?: import("../slides").PreviewEvent[];
  workspaceEvents?: WorkspaceRecordingEvent[];
  runtimeEvents?: RuntimeRecordingEvent[];
  slides?: Array<{
    id: string;
    imageUrl: string;
    name?: string;
    order: number;
  }>;
  audioBlob?: Blob | import("../types").AudioPlaceholder;
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
  VERSION: 3 as const,
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
export function isDeltaRecording(
  recording: unknown,
): recording is DeltaRecording {
  return (
    typeof recording === "object" &&
    recording !== null &&
    "version" in recording &&
    ((recording as DeltaRecording).version === 2 ||
      (recording as DeltaRecording).version === 3)
  );
}
