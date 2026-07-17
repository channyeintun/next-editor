import type { EditorFrame, MouseCursorPosition, EditorSelection, EditorPosition } from "../types";
import type { SlidePreviewState, PreviewState } from "../slides";
import type {
  ContentDelta,
  ContentEditDelta,
  PositionDelta,
  SelectionDelta,
  FrameDelta,
  Keyframe,
  DeltaFrame,
} from "./deltaTypes";
import { DELTA_CONFIG, isKeyframe, isDelta } from "./deltaTypes";
export { isKeyframe, isDelta };
import { findCommonPrefixJS, findCommonSuffixJS } from "./stringAffix";
import { getDmpCodec } from "../../../storage/dmpCodec/dmpCodec";
import { arePreviewSizesEqual, areStructuredDataEqual } from "../../../utils/equality";
import {
  normalizeEditorFrame,
  normalizeEditorPosition,
  normalizeEditorSelection,
  normalizeEditorViewState,
} from "./editorState";
import { areMouseCursorPositionsEqual } from "./cursorCoordinates";
import {
  applyTextEditEvent,
  type TextEditChange,
  type TextEditEvent,
} from "../../../types/textEdit";

const LINEAR_SCAN_LIMIT = 128;
const keyframeIndexCache = new WeakMap<DeltaFrame[], number[]>();

/**
 * Finds the length of the common prefix between two strings, in code units,
 * without cutting in the middle of a multi-byte UTF-8 character.
 */
export function findCommonPrefixLength(str1: string, str2: string): number {
  return findCommonPrefixJS(str1, str2);
}

/**
 * Finds the length of the common suffix between two strings, in code units,
 * without cutting in the middle of a multi-byte UTF-8 character.
 */
export function findCommonSuffixLength(str1: string, str2: string): number {
  return findCommonSuffixJS(str1, str2);
}

// ============================================================================
// Content Delta Functions
// ============================================================================

const contentTextEncoder = new TextEncoder();
const contentTextDecoder = new TextDecoder();
const MAX_CONTENT_EDIT_CHANGES = 64;
const MAX_CONTENT_EDIT_CODE_UNITS = 256 * 1024;

function hasBoundedContentEditChanges(value: unknown): value is readonly TextEditChange[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CONTENT_EDIT_CHANGES) {
    return false;
  }

  let changedCodeUnits = 0;
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) return false;
    const change = candidate as Partial<TextEditChange>;
    if (
      typeof change.offset !== "number" ||
      !Number.isSafeInteger(change.offset) ||
      change.offset < 0 ||
      typeof change.deleteLength !== "number" ||
      !Number.isSafeInteger(change.deleteLength) ||
      change.deleteLength < 0 ||
      typeof change.text !== "string"
    ) {
      return false;
    }
    changedCodeUnits += change.deleteLength + change.text.length;
    if (!Number.isSafeInteger(changedCodeUnits) || changedCodeUnits > MAX_CONTENT_EDIT_CODE_UNITS) {
      return false;
    }
  }
  return true;
}

/** FNV-1a over UTF-16 code units, without allocating an encoded full-string copy. */
function hashContentEditText(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    hash ^= codeUnit & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= codeUnit >>> 8;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class ContentEditBaseMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentEditBaseMismatchError";
  }
}

export interface CreatedContentEditDelta {
  base: string;
  content: string;
  delta: ContentEditDelta;
}

/**
 * Converts a validated, ordinary Monaco change into the compact replay form.
 * Full-document replacement and large edit batches intentionally return null,
 * retaining the DMP fallback for bulk/programmatic changes.
 */
export function createContentEditDelta(
  base: string,
  event: TextEditEvent,
): CreatedContentEditDelta | null {
  if (!hasBoundedContentEditChanges(event.changes)) return null;

  const onlyChange = event.changes.length === 1 ? event.changes[0] : undefined;
  if (
    onlyChange &&
    event.beforeLength > 0 &&
    onlyChange.offset === 0 &&
    onlyChange.deleteLength === event.beforeLength
  ) {
    return null;
  }

  const content = applyTextEditEvent(base, event);
  if (content === null || content === base) return null;

  return {
    base,
    content,
    delta: {
      version: 1,
      beforeLength: base.length,
      afterLength: content.length,
      beforeHash: hashContentEditText(base),
      afterHash: hashContentEditText(content),
      changes: event.changes.map((change) => ({ ...change })),
    },
  };
}

function contentEditDeltaMatches(
  base: string,
  content: string,
  created: CreatedContentEditDelta,
): boolean {
  const { delta } = created;
  return (
    created.base === base &&
    created.content === content &&
    delta.version === 1 &&
    delta.beforeLength === base.length &&
    delta.afterLength === content.length &&
    Number.isSafeInteger(delta.beforeHash) &&
    Number.isSafeInteger(delta.afterHash)
  );
}

export function applyContentEditDelta(base: string, delta: ContentEditDelta): string {
  if (
    delta.version !== 1 ||
    !Number.isSafeInteger(delta.beforeLength) ||
    !Number.isSafeInteger(delta.afterLength) ||
    delta.beforeLength < 0 ||
    delta.afterLength < 0 ||
    !Number.isSafeInteger(delta.beforeHash) ||
    !Number.isSafeInteger(delta.afterHash) ||
    delta.beforeHash < 0 ||
    delta.beforeHash > 0xffffffff ||
    delta.afterHash < 0 ||
    delta.afterHash > 0xffffffff ||
    !hasBoundedContentEditChanges(delta.changes)
  ) {
    throw new Error("content edit delta is malformed or uses an unsupported version");
  }
  if (base.length !== delta.beforeLength || hashContentEditText(base) !== delta.beforeHash) {
    throw new ContentEditBaseMismatchError(
      "content edit delta base mismatch — edits applied against the wrong base content",
    );
  }

  const content = applyTextEditEvent(base, {
    fileId: "recording",
    path: "recording",
    beforeVersion: 0,
    afterVersion: 1,
    beforeLength: delta.beforeLength,
    afterLength: delta.afterLength,
    changes: delta.changes,
  });
  if (content === null) throw new Error("content edit delta contains invalid edits");
  if (hashContentEditText(content) !== delta.afterHash) {
    throw new Error("content edit delta result failed its integrity check");
  }
  return content;
}

function applyContentEditDeltaAt(
  base: string,
  delta: ContentEditDelta,
  frameIndex?: number,
): string {
  try {
    return applyContentEditDelta(base, delta);
  } catch (error) {
    if (frameIndex === undefined || !(error instanceof Error)) throw error;
    error.message = `content edit delta failed at frame ${frameIndex}: ${error.message}`;
    throw error;
  }
}

/**
 * Creates a content delta representing the change from prev to next.
 * Returns null if content is identical.
 */
export function createContentDelta(prev: string, next: string): ContentDelta | null {
  if (prev === next) return null;

  const delta = getDmpCodec().diffDelta(
    contentTextEncoder.encode(prev),
    contentTextEncoder.encode(next),
  );
  return { delta };
}

/**
 * Reconstructs content by applying a delta to base content. `base` must equal
 * the `prev` the delta was created against (the same contract the prior
 * prefix/suffix model relied on); the codec throws otherwise.
 */
export function applyContentDelta(base: string, delta: ContentDelta): string {
  const rebuilt = getDmpCodec().applyDelta(contentTextEncoder.encode(base), delta.delta);
  return contentTextDecoder.decode(rebuilt);
}

/**
 * Same as {@link applyContentDelta}, but on failure rethrows with `frameIndex`
 * folded into the message so a replay desync (dmp base mismatch or a corrupt
 * delta) is attributable to the frame that failed, instead of surfacing as a
 * bare codec error with no reconstruction context. Mutates and rethrows the
 * original error (rather than wrapping it in a new one) so `instanceof
 * DmpBaseMismatchError` still holds for callers that distinguish it from a
 * corrupt-delta error. No-op when `frameIndex` is omitted.
 */
function applyContentDeltaAt(base: string, delta: ContentDelta, frameIndex?: number): string {
  try {
    return applyContentDelta(base, delta);
  } catch (error) {
    if (frameIndex === undefined || !(error instanceof Error)) throw error;
    error.message = `content delta failed at frame ${frameIndex}: ${error.message}`;
    throw error;
  }
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
        // dmp codec unavailable: fall back to the full copy rather than fail
        // the capture.
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
      content: applyContentDeltaAt(basePreviewState?.content ?? "", contentDelta, frameIndex),
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
  const normalizedBase = normalizeEditorFrame(base);
  if (delta.contentDelta && delta.contentEditDelta) {
    throw new Error(
      frameIndex === undefined
        ? "frame contains conflicting content delta variants"
        : `frame ${frameIndex} contains conflicting content delta variants`,
    );
  }
  const newContent = delta.contentEditDelta
    ? applyContentEditDeltaAt(normalizedBase.state.content, delta.contentEditDelta, frameIndex)
    : delta.contentDelta
      ? applyContentDeltaAt(normalizedBase.state.content, delta.contentDelta, frameIndex)
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
      previewState: resolvePreviewStateDelta(
        delta.previewState,
        normalizedBase.state.previewState,
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
      current = applyFrameDelta(current, frame, i);
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
