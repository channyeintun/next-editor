import type * as monaco from "monaco-editor";
import type { EditorActionArgs, EditorContextUpdate, EditorMachineContext } from "./types";
import type { EditorFrame } from "../types";
import type { PreviewState } from "../preview";
import { slidePreviewStateChanged } from "../slides";
import { isKeyframe, type DeltaFrame, type FrameDelta } from "../utils/deltaTypes";
import type { WorkspaceRecordingEvent } from "../workspace";
import {
  reconstructFrameAtIndex,
  applyFrameDeltaToNormalized,
  findNearestKeyframeIndex,
} from "../utils/frameDelta";
import { findFrameIndexAtTime } from "../utils/timedIndex";
import { isEditorReady, isValidEditorState } from "../utils/validation";
import { arePreviewSizesEqual, areStructuredDataEqual } from "../utils/equality";
import { applyContentDiff } from "../utils/editorDiff";
import { reportMachineError } from "./machineError";
import { asReplayWrite, isLearnerCaretHeld, showRecordedCaret } from "./playbackCaret";
import { resolveBoundedReplayTime } from "./replayStep";
import { getRecordedActiveFilePath } from "./replayState";

// ============================================================================
// Editor frame replay
//
// Brings the Monaco editor to the playhead: folding the recorded frames
// (applyFrameAtTime) and applying one to the editor (applyFrameState). How the
// recorded caret is shown, and whether the editor's caret is the recording's or
// the learner's, belongs to playbackCaret.ts, as do the caret's machine actions.
// applyFrameAtTime is one of the replay steps in replayActions.ts; the frames'
// slide and preview fallbacks for recordings without those tracks ride along
// with it.
// ============================================================================

/**
 * The Monaco-rendered frame no longer matches the editor (its model was swapped or its
 * text replaced): the next apply re-derives it from the nearest keyframe.
 */
export const RENDERED_FRAME_RESET = {
  currentFrame: null,
  lastAppliedFrameIndex: -1,
} as const satisfies EditorContextUpdate;

/**
 * Preview scroll offsets within this many pixels count as unchanged, so fractional scroll
 * values do not re-apply the preview.
 */
const PREVIEW_SCROLL_TOLERANCE_PX = 1;

const editorModelBoundaryTimeCache = new WeakMap<readonly WorkspaceRecordingEvent[], number[]>();

/**
 * Frames before the latest active-editor identity change belong to a different
 * Monaco model and must not be applied after a workspace replay switches files.
 *
 * Same-file workspace snapshots are deliberately not boundaries. Studio writes
 * one immediately after `editor.type` so the runnable workspace receives the
 * final code; its timestamp is necessarily a beat later than the editor frame
 * that captured the visible edit. Treating every workspace event as a boundary
 * drops that typed frame until the next cursor/selection frame.
 */
export function latestEditorModelBoundaryTime(
  workspaceEvents: readonly WorkspaceRecordingEvent[] | undefined,
  lastAppliedIndex: number,
): number | null {
  if (!workspaceEvents?.length || lastAppliedIndex < 0) {
    return null;
  }

  const boundedIndex = Math.min(lastAppliedIndex, workspaceEvents.length - 1);
  let boundaryTimes = editorModelBoundaryTimeCache.get(workspaceEvents);
  if (!boundaryTimes) {
    boundaryTimes = [];
    editorModelBoundaryTimeCache.set(workspaceEvents, boundaryTimes);
  }

  // Recording streams append events to the same array, so extend the cache
  // only as far as this replay cursor needs instead of rescanning on every tick.
  for (let index = boundaryTimes.length; index <= boundedIndex; index += 1) {
    const event = workspaceEvents[index];
    if (index === 0) {
      boundaryTimes.push(event.timestamp);
      continue;
    }

    const previousEvent = workspaceEvents[index - 1];
    const changedModel =
      event.snapshot.project.id !== previousEvent.snapshot.project.id ||
      event.snapshot.activeFilePath !== previousEvent.snapshot.activeFilePath;
    boundaryTimes.push(changedModel ? event.timestamp : boundaryTimes[index - 1]);
  }

  return boundaryTimes[boundedIndex] ?? null;
}

/**
 * Whether the frame at `frameIndex` was captured before the open file's model came to
 * the front, so it belongs to the file open before (latestEditorModelBoundaryTime).
 */
function predatesOpenFileModel(
  context: EditorMachineContext,
  frames: readonly DeltaFrame[],
  frameIndex: number,
): boolean {
  const boundaryTime = latestEditorModelBoundaryTime(
    context.recording?.workspaceEvents,
    context.lastAppliedWorkspaceEventIndex,
  );
  return boundaryTime !== null && frames[frameIndex].timestamp < boundaryTime;
}

/**
 * Whether the file in front of the viewer is the one the recording has open at
 * `workspaceEventIndex`. Frames carry no file path, so a frame may only be shown in, or
 * copied into, that file: a file the viewer opened themselves never gets one.
 */
export function isRecordedFileInFront(
  context: EditorMachineContext,
  workspaceEventIndex: number,
): boolean {
  const recordedPath = getRecordedActiveFilePath(context.recording, workspaceEventIndex);
  return (
    recordedPath !== undefined && context.getWorkspaceSnapshot?.()?.activeFilePath === recordedPath
  );
}

/**
 * Apply editor state from a frame
 */
export const applyFrameState = (
  editor: monaco.editor.IStandaloneCodeEditor,
  frame: EditorFrame,
  previousFrame?: EditorFrame | null,
): void => {
  if (!frame.state || !isEditorReady(editor)) return;

  // Replay frames are already normalized: recording keyframes by the load and the
  // codec, delta results by applyFrameDelta. A keyframe is the recording's own
  // object, though, so Monaco gets a copy of its view state.
  const { state } = frame;

  try {
    // Every write below is replay's: the cursor changes Monaco reports for them must
    // not be taken for a caret the learner placed (playbackCaret.ts).
    asReplayWrite(() => {
      // Apply content changes
      if (!previousFrame || previousFrame.state.content !== state.content) {
        applyContentDiff(editor, state.content);
      }

      const viewStateChanged =
        !!state.viewState &&
        (!previousFrame || !areStructuredDataEqual(state.viewState, previousFrame.state.viewState));

      // Restore scroll/layout first, then explicitly reapply selection so
      // Monaco cursorState inside viewState cannot override the recorded caret.
      if (viewStateChanged) {
        try {
          const viewState = structuredClone(state.viewState);
          // The learner has placed the editor's caret: the view still follows the
          // recording, the caret stays theirs. Monaco skips the cursor restore for an
          // empty cursor state.
          if (viewState && isLearnerCaretHeld(editor)) {
            viewState.cursorState = [];
          }
          editor.restoreViewState(viewState);
        } catch (err) {
          console.error("Failed to restore view state:", err);
        }
      }

      showRecordedCaret(editor, state.selection);
    });
  } catch (error) {
    console.error("Error applying editor state:", error);
  }
};

/**
 * The editor state at `frameIndex`, folded from the applied frame or rebuilt from its
 * keyframe, or null when that frame must be skipped: its reconstruction threw (reported
 * here) or produced an invalid state.
 */
function foldFrameAtIndex(
  context: EditorMachineContext,
  frames: DeltaFrame[],
  frameIndex: number,
): EditorFrame | null {
  const { currentFrame, lastAppliedFrameIndex } = context;
  const targetFrame = frames[frameIndex];
  let frame: EditorFrame | null;

  // Reconstruction throws by design on a damaged recording
  // (ContentEditBaseMismatchError, DmpBaseMismatchError, conflicting delta
  // variants). This runs inside an xstate `assign`, and xstate treats an action
  // throw as fatal: the actor stops, observers are cleared, and every later send
  // — including recording — is a no-op, with `onError` never called. So one bad
  // frame used to freeze the whole editor for the rest of the page session.
  // Skipping the frame and reporting it lets playback continue past the damage.
  // The caller clears currentFrame for a skipped frame, as it does for the
  // model-boundary skip, so the forward fold below never runs on a base that is
  // not the fold at lastAppliedFrameIndex: relative caret deltas would land on the
  // wrong base. The rest of the damaged keyframe span is then skipped too (one
  // report per frame) until the next keyframe re-bases the editor.
  try {
    if (isKeyframe(targetFrame)) {
      // Keyframe: always use directly, most efficient
      frame = targetFrame;
    } else if (
      currentFrame &&
      lastAppliedFrameIndex >= 0 &&
      frameIndex > lastAppliedFrameIndex &&
      findNearestKeyframeIndex(frames, frameIndex) <= lastAppliedFrameIndex
    ) {
      // Forward within the applied frame's keyframe span: apply only the crossed
      // deltas. A tick often crosses several frames (mouse frames and
      // content-plus-cursor pairs a few ms apart, more at 2x), and rebuilding from
      // the keyframe re-applied up to ~120 deltas each time. currentFrame is the
      // normalized fold at lastAppliedFrameIndex, so the result equals
      // reconstruction. Past a keyframe, reconstructing from it is the shorter walk.
      let next = currentFrame;
      for (let index = lastAppliedFrameIndex + 1; index <= frameIndex; index++) {
        next = applyFrameDeltaToNormalized(next, frames[index] as FrameDelta, index);
      }
      frame = next;
    } else {
      // Backward, or past a keyframe: rebuild from the nearest keyframe
      frame = reconstructFrameAtIndex(frames, frameIndex);
    }
  } catch (error) {
    reportMachineError(
      context,
      error instanceof Error
        ? error
        : new Error(`Could not reconstruct recording frame ${frameIndex}`),
    );
    return null;
  }

  if (!frame || !isValidEditorState(frame.state)) return null;
  return frame;
}

/**
 * Mirrors a frame's slide state to the host. Runs only for a recording without a
 * slideEvents track; when the track exists, the slide replay applies it instead.
 */
function mirrorFrameSlideState(
  context: EditorMachineContext,
  frame: EditorFrame,
  previousFrame: EditorFrame | null,
): void {
  const { slideState, currentSlideIndex } = frame.state;
  if (
    !slideState ||
    currentSlideIndex === undefined ||
    !context.applySlideState ||
    context.recording?.slideEvents?.length
  ) {
    return;
  }

  // Check if this slide state has changed to prevent excessive re-renders
  const prevSlideState = previousFrame?.state.slideState;
  const prevSlideIndex = previousFrame?.state.currentSlideIndex;

  const hasChanged =
    !prevSlideState ||
    slidePreviewStateChanged(prevSlideState, slideState) ||
    currentSlideIndex !== prevSlideIndex;

  if (hasChanged) {
    context.applySlideState(slideState, currentSlideIndex);
  }
}

/**
 * Mirrors a frame's preview panel state to the host. Runs only for a recording without a
 * previewEvents track. Returns the state it applied, or undefined when it applied none.
 */
function mirrorFramePreviewState(
  context: EditorMachineContext,
  frame: EditorFrame,
): PreviewState | undefined {
  const { previewState } = frame.state;
  // Dedicated preview events capture preview UI state changes more
  // accurately than editor frames, so only fall back to frame snapshots
  // when no preview event stream exists.
  if (!previewState || !context.applyPreviewState || context.recording?.previewEvents?.length) {
    return undefined;
  }

  const nextState = {
    ...previewState,
    refreshKey: undefined,
    currentInteraction: undefined,
  };
  const currentState = context.lastAppliedPreviewState;

  if (
    !currentState ||
    !arePreviewSizesEqual(nextState.size, currentState.size) ||
    nextState.isOpen !== currentState.isOpen ||
    nextState.mode !== currentState.mode ||
    nextState.content !== currentState.content ||
    Math.abs((nextState.scrollTop || 0) - (currentState.scrollTop || 0)) >
      PREVIEW_SCROLL_TOLERANCE_PX ||
    Math.abs((nextState.scrollLeft || 0) - (currentState.scrollLeft || 0)) >
      PREVIEW_SCROLL_TOLERANCE_PX
  ) {
    context.applyPreviewState(nextState);
    return nextState;
  }
  return undefined;
}

export const applyFrameAtTime = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  const { recording, editorRefs, lastAppliedFrameIndex, currentFrame } = context;
  const currentTime = resolveBoundedReplayTime(context, event);

  if (!recording || !editorRefs.editor || context.pendingPlaybackEditorSync) {
    return {};
  }

  const frames = recording.frames;
  if (!frames?.length) return {};

  const frameIndex = findFrameIndexAtTime(frames, currentTime, lastAppliedFrameIndex);

  // Checked before the "same frame as last time" return below: a file can be
  // opened between two applies with no new frame captured (away from the open
  // file and back). The frame on screen then predates the file's model, and a
  // seek to this time would not apply it, so a tick must stop counting it as
  // applied too.
  if (predatesOpenFileModel(context, frames, frameIndex)) {
    if (frameIndex === lastAppliedFrameIndex && currentFrame === null) {
      return {};
    }
    return {
      lastAppliedFrameIndex: frameIndex,
      currentFrame: null,
    };
  }

  if (frameIndex === lastAppliedFrameIndex) {
    return {};
  }

  // A skipped frame leaves no fold at its index for the next tick to build on.
  const frame = foldFrameAtIndex(context, frames, frameIndex);
  if (!frame) {
    return { lastAppliedFrameIndex: frameIndex, currentFrame: null };
  }

  applyFrameState(editorRefs.editor, frame, currentFrame);

  const updates: EditorContextUpdate = {
    lastAppliedFrameIndex: frameIndex,
    currentFrame: frame,
  };

  mirrorFrameSlideState(context, frame, currentFrame);
  const previewState = mirrorFramePreviewState(context, frame);
  if (previewState) {
    updates.lastAppliedPreviewState = previewState;
  }

  return updates;
};

/**
 * The workspace goes to the viewer (a seek while paused or ended, a pause, the end) while
 * the frame at the playhead waits for the editor to bind the file a replayed switch just
 * put in front (pendingPlaybackEditorSync). The hand-over detaches, so no binding after it
 * re-syncs the replay, and the file would show the workspace event's text, without what
 * was typed since, until PLAY. So the frame is resolved here without the editor:
 * adoptPlaybackWorkspaceAtPause puts its text into the file before the editor shows it,
 * and it is kept for the binding to show its caret, selection and scroll.
 *
 * Only while the file in front is the one the recording has open: a file the viewer
 * opened gets no frame.
 */
export const resolveFrameWithheldForEditor = ({
  context,
  event,
}: EditorActionArgs): EditorContextUpdate => {
  const frames = context.recording?.frames;
  // Without an editor (a binary file is shown) no frame is applied anywhere, as in
  // applyFrameAtTime.
  if (
    !frames?.length ||
    !context.editorRefs.editor ||
    !context.pendingPlaybackEditorSync ||
    context.hasManualWorkspaceOverride ||
    !isRecordedFileInFront(context, context.lastAppliedWorkspaceEventIndex)
  ) {
    return {};
  }

  const frameIndex = findFrameIndexAtTime(frames, resolveBoundedReplayTime(context, event));
  if (predatesOpenFileModel(context, frames, frameIndex)) return {};
  // Rebuilt from its keyframe: nothing was applied to this file's model to fold onto.
  const frame = foldFrameAtIndex(
    { ...context, currentFrame: null, lastAppliedFrameIndex: -1 },
    frames,
    frameIndex,
  );
  if (!frame) return {};

  mirrorFrameSlideState(context, frame, null);
  const previewState = mirrorFramePreviewState(context, frame);
  return {
    currentFrame: frame,
    lastAppliedFrameIndex: frameIndex,
    frameAwaitingEditor: frame,
    ...(previewState ? { lastAppliedPreviewState: previewState } : {}),
  };
};

/**
 * SET_EDITOR_REF: the editor has bound a model. When it is the file whose frame the
 * hand-over resolved, it holds exactly that frame's text, and the frame's caret, selection
 * and scroll are shown on it. A model with other text is another file, or one the viewer
 * has changed, and gets nothing. Either way the wait ends with this binding: any later
 * one belongs to the viewer.
 */
export const showFrameAwaitingEditor = ({
  context,
  event,
}: EditorActionArgs): EditorContextUpdate => {
  const frame = context.frameAwaitingEditor;
  if (event.type !== "SET_EDITOR_REF" || !event.editor || !frame) return {};
  if (
    context.hasManualWorkspaceOverride &&
    event.editor.getModel()?.getValue() === frame.state.content
  ) {
    applyFrameState(event.editor, frame);
  }
  return { frameAwaitingEditor: null };
};

/** The viewer acted, or the recording changed, before the editor bound the frame's file. */
export const clearFrameAwaitingEditor = (): EditorContextUpdate => ({
  frameAwaitingEditor: null,
});
