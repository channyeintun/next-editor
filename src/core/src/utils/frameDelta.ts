import type { EditorFrame, MouseCursorPosition, EditorSelection, EditorPosition } from "../types";
import type { SlidePreviewState, PreviewState } from "../slides";
import type {
  ContentDelta,
  PositionDelta,
  SelectionDelta,
  FrameDelta,
  Keyframe,
  DeltaFrame,
} from "./deltaTypes";
import { DELTA_CONFIG, isKeyframe, isDelta } from "./deltaTypes";
export { isKeyframe, isDelta };
import {
  findCommonAffixLengthsWasm,
  findCommonPrefixLengthWasm,
  findCommonSuffixLengthWasm,
} from "./wasm";
import { arePreviewSizesEqual, areStructuredDataEqual } from "../../../utils/equality";
import {
  normalizeEditorFrame,
  normalizeEditorPosition,
  normalizeEditorSelection,
  normalizeEditorViewState,
} from "./editorState";

const LINEAR_SCAN_LIMIT = 128;
const keyframeIndexCache = new WeakMap<DeltaFrame[], number[]>();

/**
 * Finds the length of the common prefix between two strings using WebAssembly.
 * Includes safety checks to ensure we don't cut in the middle of a multi-byte UTF-8 character.
 */
export function findCommonPrefixLength(str1: string, str2: string): number {
  return findCommonPrefixLengthWasm(str1, str2) ?? findCommonPrefixJS(str1, str2);
}

/**
 * Finds the length of the common suffix between two strings using WebAssembly.
 * Includes safety checks to ensure we don't cut in the middle of a multi-byte UTF-8 character.
 */
export function findCommonSuffixLength(str1: string, str2: string): number {
  return findCommonSuffixLengthWasm(str1, str2) ?? findCommonSuffixJS(str1, str2);
}

// Fallback JS implementations
function findCommonPrefixJS(str1: string, str2: string): number {
  const minLen = Math.min(str1.length, str2.length);
  let i = 0;
  while (i < minLen && str1[i] === str2[i]) i++;
  return i;
}

function findCommonSuffixJS(str1: string, str2: string): number {
  const minLen = Math.min(str1.length, str2.length);
  let i = 0;
  while (i < minLen && str1[str1.length - 1 - i] === str2[str2.length - 1 - i]) i++;
  return i;
}

// ============================================================================
// Content Delta Functions
// ============================================================================

/**
 * Creates a content delta representing the change from prev to next.
 * Returns null if content is identical.
 */
export function createContentDelta(prev: string, next: string): ContentDelta | null {
  if (prev === next) return null;

  const wasmAffixes = findCommonAffixLengthsWasm(prev, next);
  const prefixLen = wasmAffixes?.prefixLen ?? findCommonPrefixJS(prev, next);
  const suffixLen =
    wasmAffixes?.suffixLen ?? findCommonSuffixJS(prev.slice(prefixLen), next.slice(prefixLen));

  // The insert is computed from the remainder after the common prefix.
  const nextRemainder = next.slice(prefixLen);

  // The insert is what's in the middle of next, after prefix and before suffix.
  const insert = nextRemainder.slice(0, nextRemainder.length - suffixLen);

  return { prefixLen, suffixLen, insert };
}

/**
 * Reconstructs content by applying a delta to base content.
 */
export function applyContentDelta(base: string, delta: ContentDelta): string {
  const prefix = base.slice(0, delta.prefixLen);
  const suffix = base.slice(base.length - delta.suffixLen);
  return prefix + delta.insert + suffix;
}

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
 */
export function applySelectionDelta(base: EditorSelection, delta: SelectionDelta): EditorSelection {
  const selectionStartLineDelta = delta.selectionStartLineDelta ?? delta.startLineDelta ?? 0;
  const selectionStartColumnDelta = delta.selectionStartColumnDelta ?? delta.startColumnDelta ?? 0;
  const positionLineDelta = delta.positionLineDelta ?? delta.endLineDelta ?? 0;
  const positionColumnDelta = delta.positionColumnDelta ?? delta.endColumnDelta ?? 0;

  return {
    startLineNumber: base.startLineNumber + (delta.startLineDelta || 0),
    startColumn: base.startColumn + (delta.startColumnDelta || 0),
    endLineNumber: base.endLineNumber + (delta.endLineDelta || 0),
    endColumn: base.endColumn + (delta.endColumnDelta || 0),
    selectionStartLineNumber: base.selectionStartLineNumber + selectionStartLineDelta,
    selectionStartColumn: base.selectionStartColumn + selectionStartColumnDelta,
    positionLineNumber: base.positionLineNumber + positionLineDelta,
    positionColumn: base.positionColumn + positionColumnDelta,
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
 * Checks if a frame index should be a keyframe.
 */
export function shouldBeKeyframe(index: number): boolean {
  return index === 0 || index % DELTA_CONFIG.KEYFRAME_INTERVAL === 0;
}

/**
 * Helper to check if mouse cursor changed.
 */
function mouseCursorChanged(
  prev: MouseCursorPosition | undefined,
  next: MouseCursorPosition | undefined,
): boolean {
  if (!prev && !next) return false;
  if (!prev || !next) return true;
  return prev.x !== next.x || prev.y !== next.y || prev.visible !== next.visible;
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
    prev.scrollTop !== next.scrollTop ||
    prev.scrollLeft !== next.scrollLeft
  );
}

/**
 * Creates a delta from previous frame to next frame.
 */
export function createFrameDelta(prev: EditorFrame, next: EditorFrame): FrameDelta {
  const delta: FrameDelta = {
    timestamp: next.timestamp,
    isKeyframe: false,
  };

  // Content delta
  const contentDelta = createContentDelta(prev.state.content, next.state.content);
  if (contentDelta) delta.contentDelta = contentDelta;

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
    delta.previewState = next.state.previewState;
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
 * Reconstructs a full frame by applying a delta to a base frame.
 */
export function applyFrameDelta(base: EditorFrame, delta: FrameDelta): EditorFrame {
  const normalizedBase = normalizeEditorFrame(base);
  const newContent = delta.contentDelta
    ? applyContentDelta(normalizedBase.state.content, delta.contentDelta)
    : normalizedBase.state.content;

  const newPosition = delta.positionDelta
    ? applyPositionDelta(normalizedBase.state.position, delta.positionDelta)
    : normalizedBase.state.position;

  const newSelection = delta.selectionDelta
    ? applySelectionDelta(normalizedBase.state.selection, delta.selectionDelta)
    : normalizedBase.state.selection;

  const normalizedPosition = normalizeEditorPosition(newPosition);
  const normalizedSelection = normalizeEditorSelection(
    newSelection,
    normalizedBase.state.selection,
    normalizedPosition,
  );

  return normalizeEditorFrame({
    timestamp: delta.timestamp,
    state: {
      content: newContent,
      position: normalizedPosition,
      selection: normalizedSelection,
      viewState: normalizeEditorViewState(
        delta.viewState !== undefined ? delta.viewState : normalizedBase.state.viewState,
        normalizedSelection,
        normalizedPosition,
      ),
      mouseCursor:
        delta.mouseCursor !== undefined ? delta.mouseCursor : normalizedBase.state.mouseCursor,
      slideState:
        delta.slideState !== undefined ? delta.slideState : normalizedBase.state.slideState,
      currentSlideIndex:
        delta.currentSlideIndex !== undefined
          ? delta.currentSlideIndex
          : normalizedBase.state.currentSlideIndex,
      previewState:
        delta.previewState !== undefined ? delta.previewState : normalizedBase.state.previewState,
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
export function findNearestKeyframeIndex(frames: DeltaFrame[], targetIndex: number): number {
  if (!frames.length) return -1;

  const boundedTargetIndex = Math.min(targetIndex, frames.length - 1);
  let keyframeIndices = keyframeIndexCache.get(frames);

  if (!keyframeIndices) {
    keyframeIndices = [];
    for (let i = 0; i < frames.length; i++) {
      if (isKeyframe(frames[i])) {
        keyframeIndices.push(i);
      }
    }
    keyframeIndexCache.set(frames, keyframeIndices);
  }

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
  frames: DeltaFrame[],
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

  // Start with keyframe state
  let current: EditorFrame = keyframe;

  // Apply deltas from keyframe+1 to target
  for (let i = keyframeIndex + 1; i <= targetIndex; i++) {
    const frame = frames[i];
    if (isKeyframe(frame)) {
      // Another keyframe - use it as new base
      current = frame;
    } else {
      current = applyFrameDelta(current, frame);
    }
  }

  return current;
}

/**
 * Converts an array of full frames to delta frames.
 * Skips frames with no changes to reduce storage.
 * First frame is always stored as keyframe.
 * Subsequent keyframe slots only stored if there are changes.
 */
export function compressFrames(fullFrames: EditorFrame[]): DeltaFrame[] {
  if (fullFrames.length === 0) return [];

  const frames: DeltaFrame[] = [];
  let lastStoredFrame: EditorFrame | null = null;

  for (let i = 0; i < fullFrames.length; i++) {
    const currentFrame = fullFrames[i];

    if (i === 0) {
      // First frame is always stored as keyframe
      frames.push(createKeyframe(currentFrame));
      lastStoredFrame = currentFrame;
    } else if (shouldBeKeyframe(i)) {
      // Keyframe slot - but only store if there are changes
      if (lastStoredFrame) {
        const delta = createFrameDelta(lastStoredFrame, currentFrame);
        if (hasChanges(delta)) {
          // Store as keyframe for efficient seeking
          frames.push(createKeyframe(currentFrame));
          lastStoredFrame = currentFrame;
        }
        // If no changes, skip - previous frame state persists
      }
    } else {
      // Delta slot - only store if there are changes
      if (lastStoredFrame) {
        const delta = createFrameDelta(lastStoredFrame, currentFrame);
        if (hasChanges(delta)) {
          frames.push(delta);
          lastStoredFrame = currentFrame;
        }
      }
    }
  }

  return frames;
}

/**
 * Find the appropriate frame index for a given timestamp (optimized)
 */
export function findFrameIndexAtTime(
  frames: Array<{ timestamp: number }>,
  time: number,
  startIndex: number = 0,
): number {
  if (!frames.length) return -1;

  const lastIndex = frames.length - 1;
  const hasValidStartIndex = startIndex >= 0 && startIndex <= lastIndex;

  if (!hasValidStartIndex) {
    return findFrameIndexAtTimeBinary(frames, time, 0, lastIndex);
  }

  if (frames[startIndex].timestamp > time) {
    return findFrameIndexAtTimeBinary(frames, time, 0, startIndex);
  }

  if (startIndex === lastIndex || frames[startIndex + 1].timestamp > time) {
    return startIndex;
  }

  const scanEnd = Math.min(lastIndex, startIndex + LINEAR_SCAN_LIMIT);

  for (let index = startIndex + 1; index <= scanEnd; index++) {
    if (frames[index].timestamp > time) {
      return index - 1;
    }
  }

  if (scanEnd === lastIndex) {
    return lastIndex;
  }

  return findFrameIndexAtTimeBinary(frames, time, scanEnd, lastIndex);
}

function findFrameIndexAtTimeBinary(
  frames: Array<{ timestamp: number }>,
  time: number,
  low: number,
  high: number,
): number {
  let nearestIndex = low > 0 ? low - 1 : 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);

    if (frames[mid].timestamp <= time) {
      nearestIndex = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return nearestIndex;
}
