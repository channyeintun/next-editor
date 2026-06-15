import type { EditorFrame } from "../types";
import type { DeltaFrame } from "./deltaTypes";
import { createFrameDelta, createKeyframe, hasChanges, shouldBeKeyframe } from "./frameDelta";

/**
 * Running state for the incremental (capture-time) frame encoder.
 *
 * This is the streaming equivalent of {@link import("./frameDelta").compressFrames}: feeding
 * frames one at a time through {@link pushFrame} produces the exact same `DeltaFrame[]` as
 * compressing the whole buffer at finalize-time, because every decision depends only on the
 * input index (`inputFrameCount`) and the last emitted frame (`lastStoredFrame`).
 */
export interface FrameStreamEncoderState {
  /** Total frames seen so far. Drives keyframe cadence via `shouldBeKeyframe`. */
  inputFrameCount: number;
  /** Last frame actually emitted (keyframe or delta base). Null before the first frame. */
  lastStoredFrame: EditorFrame | null;
  /** Last frame fed to the encoder, regardless of emission. Used for mouse-throttle timing. */
  lastFullFrame: EditorFrame | null;
}

/**
 * Creates an empty incremental frame encoder.
 */
export function createFrameStreamEncoder(): FrameStreamEncoderState {
  return {
    inputFrameCount: 0,
    lastStoredFrame: null,
    lastFullFrame: null,
  };
}

/**
 * Folds a single captured frame into the encoder.
 *
 * Returns the next encoder state plus the `DeltaFrame` to append (or `null` when the frame
 * produced no changes and is skipped). The decision tree mirrors `compressFrames` exactly:
 *
 * - first frame (`inputFrameCount === 0`) → keyframe;
 * - keyframe slot with changes → keyframe;
 * - delta slot with changes → delta;
 * - no changes → nothing emitted (the input index still advances).
 */
export function pushFrame(
  state: FrameStreamEncoderState,
  frame: EditorFrame,
): { state: FrameStreamEncoderState; emitted: DeltaFrame | null } {
  const index = state.inputFrameCount;
  let lastStoredFrame = state.lastStoredFrame;
  let emitted: DeltaFrame | null = null;

  if (index === 0) {
    // First frame is always stored as keyframe.
    emitted = createKeyframe(frame);
    lastStoredFrame = frame;
  } else if (shouldBeKeyframe(index)) {
    // Keyframe slot - but only store if there are changes.
    if (lastStoredFrame) {
      const delta = createFrameDelta(lastStoredFrame, frame);
      if (hasChanges(delta)) {
        emitted = createKeyframe(frame);
        lastStoredFrame = frame;
      }
    }
  } else if (lastStoredFrame) {
    // Delta slot - only store if there are changes.
    const delta = createFrameDelta(lastStoredFrame, frame);
    if (hasChanges(delta)) {
      emitted = delta;
      lastStoredFrame = frame;
    }
  }

  return {
    state: {
      inputFrameCount: index + 1,
      lastStoredFrame,
      lastFullFrame: frame,
    },
    emitted,
  };
}
