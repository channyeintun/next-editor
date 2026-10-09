import type { EditorFrame, MouseCursorPosition, EditorSelection, EditorPosition } from "../types";
import type { PreviewState } from "../preview";
import type { SlidePreviewState } from "../slides";
import type { PositionDelta, SelectionDelta, FrameDelta, Keyframe, DeltaFrame } from "./deltaTypes";
import { isKeyframe } from "./deltaTypes";
import { arePreviewSizesEqual, areStructuredDataEqual } from "./equality";
import {
  normalizeEditorFrame,
  normalizeEditorPosition,
  normalizeEditorSelection,
} from "./editorState";
import { areMouseCursorPositionsEqual } from "./cursorCoordinates";
import {
  applyContentDelta,
  applyContentEditDelta,
  contentEditDeltaMatches,
  createContentDelta,
  type CreatedContentEditDelta,
} from "./contentDelta";

interface KeyframeIndex {
  /** Ascending frame indices that are keyframes. */
  indices: number[];
  /** How far into `frames` the scan has run — streams append to the same array. */
  scannedLength: number;
}

const keyframeIndexCache = new WeakMap<readonly DeltaFrame[], KeyframeIndex>();

// ============================================================================
// Position/Selection Delta Functions
// ============================================================================

/**
 * Creates a position delta, returns null if identical.
 */
export function createPositionDelta(
  prev: EditorPosition,
  next: EditorPosition,
): PositionDelta | null {
  const lineDelta = next.lineNumber - prev.lineNumber;
  const columnDelta = next.column - prev.column;
  if (lineDelta === 0 && columnDelta === 0) return null;
  return { lineDelta, columnDelta };
}

/**
 * Applies a position delta to a base position.
 */
export function applyPositionDelta(base: EditorPosition, delta: PositionDelta): EditorPosition {
  return {
    lineNumber: base.lineNumber + delta.lineDelta,
    column: base.column + delta.columnDelta,
  };
}

/**
 * Creates a selection delta, returns null if identical.
 */
export function createSelectionDelta(
  prev: EditorSelection,
  next: EditorSelection,
): SelectionDelta | null {
  const startLineDelta = next.startLineNumber - prev.startLineNumber;
  const startColumnDelta = next.startColumn - prev.startColumn;
  const endLineDelta = next.endLineNumber - prev.endLineNumber;
  const endColumnDelta = next.endColumn - prev.endColumn;
  const selectionStartLineDelta = next.selectionStartLineNumber - prev.selectionStartLineNumber;
  const selectionStartColumnDelta = next.selectionStartColumn - prev.selectionStartColumn;
  const positionLineDelta = next.positionLineNumber - prev.positionLineNumber;
  const positionColumnDelta = next.positionColumn - prev.positionColumn;

  const delta: SelectionDelta = {};

  if (startLineDelta !== 0) delta.startLineDelta = startLineDelta;
  if (startColumnDelta !== 0) delta.startColumnDelta = startColumnDelta;
  if (endLineDelta !== 0) delta.endLineDelta = endLineDelta;
  if (endColumnDelta !== 0) delta.endColumnDelta = endColumnDelta;
  if (selectionStartLineDelta !== 0) {
    delta.selectionStartLineDelta = selectionStartLineDelta;
  }
  if (selectionStartColumnDelta !== 0) {
    delta.selectionStartColumnDelta = selectionStartColumnDelta;
  }
  if (positionLineDelta !== 0) delta.positionLineDelta = positionLineDelta;
  if (positionColumnDelta !== 0) delta.positionColumnDelta = positionColumnDelta;

  if (Object.keys(delta).length === 0) {
    return null;
  }

  return delta;
}

/**
 * Applies a selection delta to a base selection.
 *
 * `createSelectionDelta` omits every field that did not move, so a missing
 * field reads as zero. The one exception is a delta with none of the anchor
 * (`selectionStart*`) or caret (`position*`) fields. The writer cannot emit
 * that for a real change, because start and end are the anchor and caret in
 * document order: if neither of those moved, neither did start or end. Such a
 * delta is the start/end-only shape, and it is read as it always was: the
 * anchor follows start and the caret follows end, which is exact for forward
 * selections.
 */
export function applySelectionDelta(base: EditorSelection, delta: SelectionDelta): EditorSelection {
  const startEndOnly =
    delta.selectionStartLineDelta === undefined &&
    delta.selectionStartColumnDelta === undefined &&
    delta.positionLineDelta === undefined &&
    delta.positionColumnDelta === undefined;
  const anchorLineDelta = startEndOnly ? delta.startLineDelta : delta.selectionStartLineDelta;
  const anchorColumnDelta = startEndOnly ? delta.startColumnDelta : delta.selectionStartColumnDelta;
  const caretLineDelta = startEndOnly ? delta.endLineDelta : delta.positionLineDelta;
  const caretColumnDelta = startEndOnly ? delta.endColumnDelta : delta.positionColumnDelta;

  return {
    startLineNumber: base.startLineNumber + (delta.startLineDelta ?? 0),
    startColumn: base.startColumn + (delta.startColumnDelta ?? 0),
    endLineNumber: base.endLineNumber + (delta.endLineDelta ?? 0),
    endColumn: base.endColumn + (delta.endColumnDelta ?? 0),
    selectionStartLineNumber: base.selectionStartLineNumber + (anchorLineDelta ?? 0),
    selectionStartColumn: base.selectionStartColumn + (anchorColumnDelta ?? 0),
    positionLineNumber: base.positionLineNumber + (caretLineDelta ?? 0),
    positionColumn: base.positionColumn + (caretColumnDelta ?? 0),
  };
}

// ============================================================================
// Frame Delta Functions
// ============================================================================

/**
 * Creates a keyframe from a full frame.
 */
export function createKeyframe(frame: EditorFrame): Keyframe {
  return { ...normalizeEditorFrame(frame), isKeyframe: true };
}

/**
 * Helper to check if mouse cursor changed.
 */
function mouseCursorChanged(
  prev: MouseCursorPosition | undefined,
  next: MouseCursorPosition | undefined,
): boolean {
  return !areMouseCursorPositionsEqual(prev, next);
}

/**
 * Helper to check if slide state changed.
 */
function slideStateChanged(
  prev: SlidePreviewState | undefined,
  next: SlidePreviewState | undefined,
): boolean {
  if (!prev && !next) return false;
  if (!prev || !next) return true;
  return (
    prev.isOpen !== next.isOpen ||
    prev.isMaximized !== next.isMaximized ||
    prev.currentSlideId !== next.currentSlideId
  );
}

/**
 * Helper to check if preview state changed.
 */
function previewStateChanged(
  prev: PreviewState | undefined,
  next: PreviewState | undefined,
): boolean {
  if (!prev && !next) return false;
  if (!prev || !next) return true;
  return (
    !arePreviewSizesEqual(prev.size, next.size) ||
    prev.isOpen !== next.isOpen ||
    prev.mode !== next.mode ||
    prev.content !== next.content ||
    prev.route !== next.route ||
    prev.scrollTop !== next.scrollTop ||
    prev.scrollLeft !== next.scrollLeft
  );
}

/**
 * Creates a delta from previous frame to next frame.
 */
export function createFrameDelta(
  prev: EditorFrame,
  next: EditorFrame,
  contentEditDelta?: CreatedContentEditDelta,
): FrameDelta {
  const delta: FrameDelta = {
    timestamp: next.timestamp,
    isKeyframe: false,
  };

  // Content delta
  if (prev.state.content !== next.state.content) {
    if (
      contentEditDelta &&
      contentEditDeltaMatches(prev.state.content, next.state.content, contentEditDelta)
    ) {
      delta.contentEditDelta = contentEditDelta.delta;
    } else {
      const contentDelta = createContentDelta(prev.state.content, next.state.content);
      if (contentDelta) delta.contentDelta = contentDelta;
    }
  }

  // Position delta
  const positionDelta = createPositionDelta(prev.state.position, next.state.position);
  if (positionDelta) delta.positionDelta = positionDelta;

  // Selection delta
  const selectionDelta = createSelectionDelta(prev.state.selection, next.state.selection);
  if (selectionDelta) delta.selectionDelta = selectionDelta;

  // Optional fields - only include if changed
  if (mouseCursorChanged(prev.state.mouseCursor, next.state.mouseCursor)) {
    delta.mouseCursor = next.state.mouseCursor;
  }

  if (slideStateChanged(prev.state.slideState, next.state.slideState)) {
    delta.slideState = next.state.slideState;
  }

  if (prev.state.currentSlideIndex !== next.state.currentSlideIndex) {
    delta.currentSlideIndex = next.state.currentSlideIndex;
  }

  if (previewStateChanged(prev.state.previewState, next.state.previewState)) {
    const nextPreview = next.state.previewState;
    const prevContent = prev.state.previewState?.content;
    // Keep the delta incremental: previewState.content is the full
    // static-preview HTML. Scroll ticks change previewState without touching
    // the content, so emit everything but the content and let applyFrameDelta
    // carry it forward; live edits change the content by keystrokes, so store
    // a dmp patch against the base content (exactly like editor content)
    // instead of another full copy.
    if (nextPreview && prevContent === nextPreview.content) {
      const { content: _content, ...rest } = nextPreview;
      delta.previewState = { ...rest, contentUnchanged: true };
    } else if (
      nextPreview &&
      typeof prevContent === "string" &&
      prevContent !== "" &&
      typeof nextPreview.content === "string" &&
      nextPreview.content !== ""
    ) {
      try {
        const previewContentDelta = createContentDelta(prevContent, nextPreview.content);
        const { content: _content, ...rest } = nextPreview;
        delta.previewState = previewContentDelta
          ? { ...rest, contentDelta: previewContentDelta }
          : { ...rest, contentUnchanged: true };
      } catch {
        // Defensive only: the codec cannot be missing during capture
        // (START_RECORDING refuses without it, the isDmpCodecMissing guard),
        // so this catches an unexpected codec failure on the preview HTML and
        // keeps the always-correct full copy rather than failing the capture.
        delta.previewState = nextPreview;
      }
    } else {
      delta.previewState = nextPreview;
    }
  }

  if (next.state.viewState && !areStructuredDataEqual(next.state.viewState, prev.state.viewState)) {
    delta.viewState = next.state.viewState;
  }

  return delta;
}

/**
 * Checks if a delta has any actual changes.
 * Returns false if the delta only contains timestamp and isKeyframe.
 */
export function hasChanges(delta: FrameDelta): boolean {
  return !!(
    delta.contentDelta ||
    delta.contentEditDelta ||
    delta.positionDelta ||
    delta.selectionDelta ||
    delta.viewState !== undefined ||
    delta.mouseCursor !== undefined ||
    delta.slideState !== undefined ||
    delta.currentSlideIndex !== undefined ||
    delta.previewState !== undefined
  );
}

/**
 * Runs `apply` (a content or content-edit delta application) and, on failure,
 * rethrows with `frameIndex` folded into the message after `label`, so a
 * replay desync (a base mismatch or a corrupt delta) is attributable to the
 * frame that failed instead of surfacing as a bare codec error with no
 * reconstruction context. Mutates and rethrows the original error (rather than
 * wrapping it in a new one) so `instanceof DmpBaseMismatchError` and
 * `instanceof ContentEditBaseMismatchError` still hold for callers that
 * distinguish them from a corrupt-delta error. No-op when `frameIndex` is
 * omitted.
 */
function withFrameIndex<T>(label: string, frameIndex: number | undefined, apply: () => T): T {
  try {
    return apply();
  } catch (error) {
    if (frameIndex === undefined || !(error instanceof Error)) throw error;
    error.message = `${label} failed at frame ${frameIndex}: ${error.message}`;
    throw error;
  }
}

/**
 * Materializes a delta's previewState against the base frame's: the
 * content-unchanged form (see {@link PreviewStateContentUnchanged}) gets the
 * base content back, the content-patched form applies its dmp patch to the
 * base content, and a full previewState (or an absent one) passes through.
 */
function resolvePreviewStateDelta(
  deltaPreviewState: FrameDelta["previewState"],
  basePreviewState: PreviewState | undefined,
  frameIndex?: number,
): PreviewState | undefined {
  if (deltaPreviewState === undefined) {
    return basePreviewState;
  }
  if ("contentUnchanged" in deltaPreviewState && deltaPreviewState.contentUnchanged) {
    const { contentUnchanged: _contentUnchanged, ...rest } = deltaPreviewState;
    return { ...rest, content: basePreviewState?.content };
  }
  if ("contentDelta" in deltaPreviewState && deltaPreviewState.contentDelta) {
    const { contentDelta, ...rest } = deltaPreviewState;
    return {
      ...rest,
      content: withFrameIndex("content delta", frameIndex, () =>
        applyContentDelta(basePreviewState?.content ?? "", contentDelta),
      ),
    };
  }
  return deltaPreviewState;
}

/**
 * Reconstructs a full frame by applying a delta to a base frame.
 *
 * `frameIndex`, when provided, is attributed on failure: a dmp base-mismatch (or
 * any other content-delta error) is rethrown with the frame index folded into
 * the message, so a replay desync can be traced back to which frame diverged
 * instead of surfacing as an opaque codec error.
 */
export function applyFrameDelta(
  base: EditorFrame,
  delta: FrameDelta,
  frameIndex?: number,
): EditorFrame {
  return applyFrameDeltaToNormalized(normalizeEditorFrame(base), delta, frameIndex);
}

/**
 * {@link applyFrameDelta} for a base that is already normalized: a keyframe that
 * went through `normalizeEditorFrame`, or an earlier result of this function.
 * Replay folds deltas onto such bases on every tick and seek, and normalizing
 * one again is a pure cost: it deep-clones the view state and changes nothing.
 * The result is still normalized (and so never shares a view state with the
 * base or the delta), which keeps the next fold's base valid.
 */
export function applyFrameDeltaToNormalized(
  base: EditorFrame,
  delta: FrameDelta,
  frameIndex?: number,
): EditorFrame {
  const { contentDelta, contentEditDelta } = delta;
  if (contentDelta && contentEditDelta) {
    throw new Error(
      frameIndex === undefined
        ? "frame contains conflicting content delta variants"
        : `frame ${frameIndex} contains conflicting content delta variants`,
    );
  }
  const newContent = contentEditDelta
    ? withFrameIndex("content edit delta", frameIndex, () =>
        applyContentEditDelta(base.state.content, contentEditDelta),
      )
    : contentDelta
      ? withFrameIndex("content delta", frameIndex, () =>
          applyContentDelta(base.state.content, contentDelta),
        )
      : base.state.content;

  const newPosition = delta.positionDelta
    ? applyPositionDelta(base.state.position, delta.positionDelta)
    : base.state.position;

  const newSelection = delta.selectionDelta
    ? applySelectionDelta(base.state.selection, delta.selectionDelta)
    : base.state.selection;

  const normalizedPosition = normalizeEditorPosition(newPosition);
  const normalizedSelection = normalizeEditorSelection(
    newSelection,
    base.state.selection,
    normalizedPosition,
  );

  // The final normalizeEditorFrame normalizes (and clones) the view state
  // against this same selection and position, so it is passed through raw.
  return normalizeEditorFrame({
    timestamp: delta.timestamp,
    state: {
      content: newContent,
      position: normalizedPosition,
      selection: normalizedSelection,
      viewState: delta.viewState !== undefined ? delta.viewState : base.state.viewState,
      mouseCursor: delta.mouseCursor !== undefined ? delta.mouseCursor : base.state.mouseCursor,
      slideState: delta.slideState !== undefined ? delta.slideState : base.state.slideState,
      currentSlideIndex:
        delta.currentSlideIndex !== undefined
          ? delta.currentSlideIndex
          : base.state.currentSlideIndex,
      previewState: resolvePreviewStateDelta(
        delta.previewState,
        base.state.previewState,
        frameIndex,
      ),
    },
  });
}

// ============================================================================
// Frame Reconstruction
// ============================================================================

/**
 * Finds the index of the nearest keyframe at or before the given frame index.
 * Searches backwards from targetIndex to find the first keyframe.
 */
export function findNearestKeyframeIndex(
  frames: readonly DeltaFrame[],
  targetIndex: number,
): number {
  if (!frames.length) return -1;

  const boundedTargetIndex = Math.min(targetIndex, frames.length - 1);
  let cached = keyframeIndexCache.get(frames);

  if (!cached) {
    cached = { indices: [], scannedLength: 0 };
    keyframeIndexCache.set(frames, cached);
  }

  // Streaming playback appends decoded frames to this same array in place
  // (APPEND_RECORDING_DELTA), so the scan is extended rather than run once. A scan
  // frozen at the pre-stream length still reconstructs correctly — the delta walk
  // re-bases on any keyframe it passes — but it walks from a far older keyframe,
  // turning a bounded seek into one over the whole streamed tail.
  const keyframeIndices = cached.indices;
  for (let i = cached.scannedLength; i < frames.length; i++) {
    if (isKeyframe(frames[i])) {
      keyframeIndices.push(i);
    }
  }
  cached.scannedLength = frames.length;

  let low = 0;
  let high = keyframeIndices.length - 1;
  let nearestIndex = -1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const keyframeIndex = keyframeIndices[mid];

    if (keyframeIndex <= boundedTargetIndex) {
      nearestIndex = keyframeIndex;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return nearestIndex; // No keyframe found should not happen if first frame is a keyframe.
}

/**
 * Reconstructs a frame at the given index from the delta frames array.
 * Works correctly with sparse frame arrays where empty frames are skipped.
 */
export function reconstructFrameAtIndex(
  frames: readonly DeltaFrame[],
  targetIndex: number,
): EditorFrame | null {
  if (targetIndex < 0 || targetIndex >= frames.length) return null;

  // Find the nearest keyframe at or before target
  const keyframeIndex = findNearestKeyframeIndex(frames, targetIndex);

  if (keyframeIndex < 0) {
    console.error("No keyframe found at or before index", targetIndex);
    return null;
  }

  const keyframe = frames[keyframeIndex];
  if (!isKeyframe(keyframe)) {
    console.error("Expected keyframe at index", keyframeIndex);
    return null;
  }

  // Normalize only the keyframes the walk starts from or re-bases on; every
  // delta result is already normalized.
  let current: EditorFrame = normalizeEditorFrame(keyframe);

  // Apply deltas from keyframe+1 to target
  for (let i = keyframeIndex + 1; i <= targetIndex; i++) {
    const frame = frames[i];
    if (isKeyframe(frame)) {
      // Another keyframe - use it as new base
      current = normalizeEditorFrame(frame);
    } else {
      current = applyFrameDeltaToNormalized(current, frame, i);
    }
  }

  return current;
}
