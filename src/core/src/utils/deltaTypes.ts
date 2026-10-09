import type * as monaco from "monaco-editor";
import type { MouseCursorPosition, EditorFrame } from "../types";
import type { PreviewState } from "../preview";
import type { SlidePreviewState } from "../slides";
import type { TextEditChange } from "../textEdit";

// ============================================================================
// Delta Compression Types
// ============================================================================

/**
 * Delta for content changes — an opaque diff-match-patch (Myers) delta that
 * transforms the previous frame's content into this frame's content. Unlike the
 * former prefix/suffix model it stays compact across multiple, non-contiguous
 * edits. General rewrites are produced by the Rust WASM codec; append-only
 * streams can emit the same checked equal/insert wire format directly. All
 * variants are consumed by applyContentDelta and stored by msgpack as a binary
 * blob.
 */
export interface ContentDelta {
  delta: Uint8Array;
}

/**
 * Versioned Monaco edit batch for ordinary local text changes. Offsets and
 * lengths are UTF-16 code units, matching Monaco and JavaScript strings. The
 * hashes make applying the batch to a stale replay base fail loudly instead of
 * silently producing divergent content.
 */
export interface ContentEditDelta {
  version: 1;
  beforeLength: number;
  afterLength: number;
  beforeHash: number;
  afterHash: number;
  changes: readonly TextEditChange[];
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
 *
 * An absent optional field means "unchanged": the player keeps the base frame's
 * value, and msgpack drops an undefined one on the wire anyway. A delta therefore
 * cannot clear a field, so a frame that clears the preview or the view state is
 * stored as a keyframe instead (see `pushFrame`).
 */
export interface FrameDelta {
  timestamp: number;
  /** Always false: marks a delta (see Keyframe). */
  isKeyframe: false;
  /** Content delta (omitted if content unchanged) */
  contentDelta?: ContentDelta;
  /** Exact Monaco edits (SCR format v3; mutually exclusive with contentDelta). */
  contentEditDelta?: ContentEditDelta;
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
 * The Recording schema version (`Recording.version`, and `version` in a stream's
 * header metadata). Every check and type derives from this one number, so a
 * schema bump cannot leave a codec refusing its own files. Unrelated to the
 * stream's byte-layout version (STREAM_FORMAT_VERSION in the codec).
 */
export const RECORDING_SCHEMA_VERSION = 4 as const;

/**
 * Configuration for delta compression
 */
export const DELTA_CONFIG = {
  /**
   * Stored frames between keyframes. Capture is event-driven, so this is a frame
   * count, not a time span; frames that change nothing are not stored or counted.
   */
  KEYFRAME_INTERVAL: 120,
  /** Format version identifier */
  VERSION: RECORDING_SCHEMA_VERSION,
} as const;

/**
 * Type guard to check if a frame is a keyframe
 */
export function isKeyframe(frame: DeltaFrame): frame is Keyframe {
  return "isKeyframe" in frame && frame.isKeyframe === true;
}
