import type * as monaco from 'monaco-editor';
import type { EditorFrame, MouseCursorPosition } from '../types';
import type { SlidePreviewState, PreviewState } from '../slides';
import type {
    ContentDelta,
    PositionDelta,
    SelectionDelta,
    FrameDelta,
    Keyframe,
    DeltaFrame,
} from './deltaTypes';
import { DELTA_CONFIG, isKeyframe } from './deltaTypes';
import { getWasmExports } from './steganography';

// ============================================================================
// Text Encoding Utilities
// ============================================================================

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Finds the length of the common prefix between two strings using WebAssembly.
 * Includes safety checks to ensure we don't cut in the middle of a multi-byte UTF-8 character.
 */
export function findCommonPrefixLength(str1: string, str2: string): number {
    const exports = getWasmExports();
    if (!exports) return findCommonPrefixJS(str1, str2);

    const memory = exports.memory;
    const baseOffset = (exports.__heap_base?.value as number) || 65536;

    const bytes1 = textEncoder.encode(str1);
    const bytes2 = textEncoder.encode(str2);

    const totalSizeNeeded = baseOffset + bytes1.length + bytes2.length;
    if (memory.buffer.byteLength < totalSizeNeeded) {
        const pagesNeeded = Math.ceil((totalSizeNeeded - memory.buffer.byteLength) / 65536);
        if (pagesNeeded > 0) memory.grow(pagesNeeded);
    }

    const ptr1 = baseOffset;
    const ptr2 = baseOffset + bytes1.length;

    new Uint8Array(memory.buffer, ptr1, bytes1.length).set(bytes1);
    new Uint8Array(memory.buffer, ptr2, bytes2.length).set(bytes2);

    let prefixBytes = exports.findCommonPrefix(ptr1, bytes1.length, ptr2, bytes2.length);

    if (prefixBytes <= 0) return 0;
    if (prefixBytes === bytes1.length) return str1.length;
    if (prefixBytes === bytes2.length) return str2.length;

    // UTF-8 safety: if we are in the middle of a multi-byte character,
    // move back until we find the start of the character (or 0).
    const wasmBytes = new Uint8Array(memory.buffer, ptr1, bytes1.length);
    while (prefixBytes > 0 && (wasmBytes[prefixBytes] & 0xC0) === 0x80) {
        prefixBytes--;
    }

    const prefixSlice = new Uint8Array(memory.buffer, ptr1, prefixBytes);
    return textDecoder.decode(prefixSlice).length;
}

/**
 * Finds the length of the common suffix between two strings using WebAssembly.
 * Includes safety checks to ensure we don't cut in the middle of a multi-byte UTF-8 character.
 */
export function findCommonSuffixLength(str1: string, str2: string): number {
    const exports = getWasmExports();
    if (!exports) return findCommonSuffixJS(str1, str2);

    const memory = exports.memory;
    const baseOffset = (exports.__heap_base?.value as number) || 65536;

    const bytes1 = textEncoder.encode(str1);
    const bytes2 = textEncoder.encode(str2);

    const totalSizeNeeded = baseOffset + bytes1.length + bytes2.length;
    if (memory.buffer.byteLength < totalSizeNeeded) {
        const pagesNeeded = Math.ceil((totalSizeNeeded - memory.buffer.byteLength) / 65536);
        if (pagesNeeded > 0) memory.grow(pagesNeeded);
    }

    const ptr1 = baseOffset;
    const ptr2 = baseOffset + bytes1.length;

    new Uint8Array(memory.buffer, ptr1, bytes1.length).set(bytes1);
    new Uint8Array(memory.buffer, ptr2, bytes2.length).set(bytes2);

    let suffixBytes = exports.findCommonSuffix(ptr1, bytes1.length, ptr2, bytes2.length);

    if (suffixBytes <= 0) return 0;
    if (suffixBytes === bytes1.length) return str1.length;
    if (suffixBytes === bytes2.length) return str2.length;

    // UTF-8 safety: ensure we aren't starting the suffix in the middle of a multi-byte character.
    // We check the first byte of the suffix (bytes1.length - suffixBytes).
    const suffixStart = bytes1.length - suffixBytes;
    const wasmBytes = new Uint8Array(memory.buffer, ptr1, bytes1.length);
    while (suffixBytes > 0 && (wasmBytes[suffixStart] & 0xC0) === 0x80) {
        suffixBytes--;
    }

    const suffixSlice = new Uint8Array(memory.buffer, ptr1 + bytes1.length - suffixBytes, suffixBytes);
    return textDecoder.decode(suffixSlice).length;
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

    const prefixLen = findCommonPrefixLength(prev, next);

    // After removing common prefix, find common suffix
    const prevRemainder = prev.slice(prefixLen);
    const nextRemainder = next.slice(prefixLen);
    const suffixLen = findCommonSuffixLength(prevRemainder, nextRemainder);

    // The insert is what's in the middle of next, after prefix and before suffix
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
    prev: monaco.IPosition,
    next: monaco.IPosition
): PositionDelta | null {
    const lineDelta = next.lineNumber - prev.lineNumber;
    const columnDelta = next.column - prev.column;
    if (lineDelta === 0 && columnDelta === 0) return null;
    return { lineDelta, columnDelta };
}

/**
 * Applies a position delta to a base position.
 */
export function applyPositionDelta(
    base: monaco.IPosition,
    delta: PositionDelta
): monaco.IPosition {
    return {
        lineNumber: base.lineNumber + delta.lineDelta,
        column: base.column + delta.columnDelta,
    };
}

/**
 * Creates a selection delta, returns null if identical.
 */
export function createSelectionDelta(
    prev: monaco.Selection,
    next: monaco.Selection
): SelectionDelta | null {
    const startLineDelta = next.startLineNumber - prev.startLineNumber;
    const startColumnDelta = next.startColumn - prev.startColumn;
    const endLineDelta = next.endLineNumber - prev.endLineNumber;
    const endColumnDelta = next.endColumn - prev.endColumn;

    if (startLineDelta === 0 && startColumnDelta === 0 &&
        endLineDelta === 0 && endColumnDelta === 0) {
        return null;
    }

    return { startLineDelta, startColumnDelta, endLineDelta, endColumnDelta };
}

/**
 * Applies a selection delta to a base selection.
 */
export function applySelectionDelta(
    base: monaco.Selection,
    delta: SelectionDelta
): monaco.Selection {
    return {
        startLineNumber: base.startLineNumber + (delta.startLineDelta || 0),
        startColumn: base.startColumn + (delta.startColumnDelta || 0),
        endLineNumber: base.endLineNumber + (delta.endLineDelta || 0),
        endColumn: base.endColumn + (delta.endColumnDelta || 0),
        selectionStartLineNumber: base.selectionStartLineNumber + (delta.startLineDelta || 0),
        selectionStartColumn: base.selectionStartColumn + (delta.startColumnDelta || 0),
        positionLineNumber: base.positionLineNumber + (delta.endLineDelta || 0),
        positionColumn: base.positionColumn + (delta.endColumnDelta || 0),
    } as monaco.Selection;
}

// ============================================================================
// Frame Delta Functions
// ============================================================================

/**
 * Creates a keyframe from a full frame.
 */
export function createKeyframe(frame: EditorFrame): Keyframe {
    return { ...frame, isKeyframe: true };
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
    next: MouseCursorPosition | undefined
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
    next: SlidePreviewState | undefined
): boolean {
    if (!prev && !next) return false;
    if (!prev || !next) return true;
    return prev.isOpen !== next.isOpen ||
        prev.isMaximized !== next.isMaximized ||
        prev.currentSlideId !== next.currentSlideId;
}

/**
 * Helper to check if preview state changed.
 */
function previewStateChanged(
    prev: PreviewState | undefined,
    next: PreviewState | undefined
): boolean {
    if (!prev && !next) return false;
    if (!prev || !next) return true;
    return prev.size !== next.size ||
        prev.scrollTop !== next.scrollTop ||
        prev.scrollLeft !== next.scrollLeft;
}

/**
 * Creates a delta from previous frame to next frame.
 */
export function createFrameDelta(
    prev: EditorFrame,
    next: EditorFrame
): FrameDelta {
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

    // ViewState is complex - include if exists and differs (simple reference check)
    if (next.state.viewState && next.state.viewState !== prev.state.viewState) {
        delta.viewState = next.state.viewState;
    }

    return delta;
}

/**
 * Reconstructs a full frame by applying a delta to a base frame.
 */
export function applyFrameDelta(
    base: EditorFrame,
    delta: FrameDelta
): EditorFrame {
    const newContent = delta.contentDelta
        ? applyContentDelta(base.state.content, delta.contentDelta)
        : base.state.content;

    const newPosition = delta.positionDelta
        ? applyPositionDelta(base.state.position, delta.positionDelta)
        : base.state.position;

    const newSelection = delta.selectionDelta
        ? applySelectionDelta(base.state.selection, delta.selectionDelta)
        : base.state.selection;

    return {
        timestamp: delta.timestamp,
        state: {
            content: newContent,
            position: newPosition as monaco.Position,
            selection: newSelection,
            viewState: delta.viewState !== undefined ? delta.viewState : base.state.viewState,
            mouseCursor: delta.mouseCursor !== undefined ? delta.mouseCursor : base.state.mouseCursor,
            slideState: delta.slideState !== undefined ? delta.slideState : base.state.slideState,
            currentSlideIndex: delta.currentSlideIndex !== undefined ? delta.currentSlideIndex : base.state.currentSlideIndex,
            previewState: delta.previewState !== undefined ? delta.previewState : base.state.previewState,
        },
    };
}

// ============================================================================
// Frame Reconstruction
// ============================================================================

/**
 * Finds the index of the keyframe at or before the given frame index.
 */
export function findKeyframeIndex(frameIndex: number): number {
    return Math.floor(frameIndex / DELTA_CONFIG.KEYFRAME_INTERVAL) * DELTA_CONFIG.KEYFRAME_INTERVAL;
}

/**
 * Reconstructs a frame at the given index from the delta frames array.
 */
export function reconstructFrameAtIndex(
    frames: DeltaFrame[],
    targetIndex: number
): EditorFrame | null {
    if (targetIndex < 0 || targetIndex >= frames.length) return null;

    // Find the keyframe at or before target
    const keyframeIndex = findKeyframeIndex(targetIndex);
    const keyframe = frames[keyframeIndex];

    if (!keyframe || !isKeyframe(keyframe)) {
        // Invalid state - first frame of every block should be keyframe
        console.error('Expected keyframe at index', keyframeIndex);
        return null;
    }

    // Start with keyframe state
    let current: EditorFrame = keyframe;

    // Apply deltas from keyframe+1 to target
    for (let i = keyframeIndex + 1; i <= targetIndex; i++) {
        const frame = frames[i];
        if (isKeyframe(frame)) {
            // Unexpected keyframe - use it as new base
            current = frame;
        } else {
            current = applyFrameDelta(current, frame);
        }
    }

    return current;
}

/**
 * Converts an array of full frames to delta frames.
 */
export function compressFrames(fullFrames: EditorFrame[]): DeltaFrame[] {
    if (fullFrames.length === 0) return [];

    const frames: DeltaFrame[] = [];

    for (let i = 0; i < fullFrames.length; i++) {
        if (shouldBeKeyframe(i)) {
            // Create keyframe
            frames.push(createKeyframe(fullFrames[i]));
        } else {
            // Create delta from previous full frame
            const delta = createFrameDelta(fullFrames[i - 1], fullFrames[i]);
            frames.push(delta);
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
    startIndex: number = 0
): number {
    if (!frames.length) return -1;

    // Fast path: try starting from previous index
    let index = Math.max(0, startIndex);

    // Ensure index is within bounds
    if (index >= frames.length) index = frames.length - 1;

    // If we've jumped back, search from the beginning
    if (frames[index].timestamp > time) {
        index = 0;
    }

    // Linear search forward (efficient for incremental ticks)
    let bestIndex = index;
    for (let i = index; i < frames.length; i++) {
        if (frames[i].timestamp <= time) {
            bestIndex = i;
        } else {
            break;
        }
    }

    return bestIndex;
}
