import type { EditorFrame } from "../types";
import { DELTA_CONFIG, isKeyframe, type DeltaFrame } from "./deltaTypes";
import type { CreatedContentEditDelta } from "./contentDelta";
import { createFrameDelta, createKeyframe, hasChanges } from "./frameDelta";

/**
 * Running state for the incremental (capture-time) frame encoder.
 *
 * Keyframe cadence counts *emitted* frames, not captures. Most captures are
 * no-ops (every keystroke fires Monaco's content, cursor-position and
 * selection events, and the last two reuse the first one's state), so a
 * cadence keyed to the capture index let keyframe slots land on the same no-op
 * phase for a whole take and starved seeking of checkpoints.
 */
export interface FrameStreamEncoderState {
  /**
   * Frames emitted since the last keyframe. Every
   * `DELTA_CONFIG.KEYFRAME_INTERVAL`-th emitted frame is a keyframe.
   */
  framesSinceKeyframe: number;
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
    framesSinceKeyframe: 0,
    lastStoredFrame: null,
    lastFullFrame: null,
  };
}

/**
 * An encoder that carries on after `frames` as if it had emitted them; `lastFrame` is
 * their fold (null when empty).
 */
export function resumeFrameStreamEncoder(
  frames: readonly DeltaFrame[],
  lastFrame: EditorFrame | null,
): FrameStreamEncoderState {
  // Deltas stored after the last keyframe: the keyframe cadence picks up from there.
  let framesSinceKeyframe = 0;
  for (let index = frames.length - 1; index >= 0; index--) {
    if (isKeyframe(frames[index])) break;
    framesSinceKeyframe++;
  }
  return { framesSinceKeyframe, lastStoredFrame: lastFrame, lastFullFrame: lastFrame };
}

/**
 * Folds a single captured frame into the encoder.
 *
 * Returns the next encoder state plus the `DeltaFrame` to append (or `null` when the frame
 * produced no changes and is skipped):
 *
 * - first frame → keyframe;
 * - the frame clears the preview or the view state → keyframe, since a delta's absent
 *   field means "unchanged" and cannot say "cleared";
 * - a keyframe is due (the last `KEYFRAME_INTERVAL - 1` emitted frames were deltas) and the
 *   frame changed → keyframe;
 * - otherwise, a changed frame → delta;
 * - no changes → nothing emitted, and a due keyframe waits for the next changed frame.
 */
export function pushFrame(
  state: FrameStreamEncoderState,
  frame: EditorFrame,
  contentEditDelta?: CreatedContentEditDelta,
): { state: FrameStreamEncoderState; emitted: DeltaFrame | null } {
  const previous = state.lastStoredFrame;
  let { framesSinceKeyframe } = state;
  let emitted: DeltaFrame | null = null;
  // Closing the preview (or losing the editor model) empties a field, and a delta cannot
  // carry that: the player reads an absent field as unchanged and keeps the old state.
  const clearsState =
    previous !== null &&
    ((previous.state.previewState !== undefined && frame.state.previewState === undefined) ||
      (previous.state.viewState != null && frame.state.viewState == null));

  if (!previous || clearsState) {
    emitted = createKeyframe(frame);
    framesSinceKeyframe = 0;
  } else if (framesSinceKeyframe + 1 >= DELTA_CONFIG.KEYFRAME_INTERVAL) {
    // The keyframe stores the full content, so a content change needs no delta
    // (and no dmp diff) just to prove the frame changed.
    if (
      previous.state.content !== frame.state.content ||
      hasChanges(createFrameDelta(previous, frame, contentEditDelta))
    ) {
      emitted = createKeyframe(frame);
      framesSinceKeyframe = 0;
    }
  } else {
    const delta = createFrameDelta(previous, frame, contentEditDelta);
    if (hasChanges(delta)) {
      emitted = delta;
      framesSinceKeyframe += 1;
    }
  }

  return {
    state: {
      framesSinceKeyframe,
      lastStoredFrame: emitted ? frame : previous,
      lastFullFrame: frame,
    },
    emitted,
  };
}

/**
 * Encodes a whole buffer of full frames at once: the batch form of
 * {@link pushFrame}, for callers that already hold every frame.
 */
export function compressFrames(fullFrames: EditorFrame[]): DeltaFrame[] {
  const frames: DeltaFrame[] = [];
  let state = createFrameStreamEncoder();
  for (const frame of fullFrames) {
    const pushed = pushFrame(state, frame);
    state = pushed.state;
    if (pushed.emitted) frames.push(pushed.emitted);
  }
  return frames;
}
