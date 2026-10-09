import type * as monaco from "monaco-editor";
import type { EditorActionArgs, EditorContextUpdate, EditorMachineContext } from "./types";
import type { EditorFrame } from "../types";
import type { PreviewState } from "../preview";
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
import { applyContentDiff, applySelectionDiff, areSelectionsEqual } from "../utils/editorDiff";
import { reportMachineError, resolveBoundedReplayTime } from "./replayStep";

// ============================================================================
// Editor frame replay
//
// Brings the Monaco editor to the playhead: folding the recorded frames
// (applyFrameAtTime), applying one to the editor (applyFrameState), and the
// playback caret's decorations. applyFrameAtTime is one of the replay steps in
// replayActions.ts; the frames' slide and preview fallbacks for recordings
// without those tracks ride along with it.
// ============================================================================

/**
 * The Monaco-rendered frame no longer matches the editor (its model was swapped or its
 * text replaced): the next apply re-derives it from the nearest keyframe.
 */
export const RENDERED_FRAME_RESET = {
  currentFrame: null,
  lastAppliedFrameIndex: -1,
} as const satisfies EditorContextUpdate;

/** Color of the playback caret's marks in the minimap and the overview ruler. */
const PLAYBACK_CURSOR_COLOR = "#007ACC";

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
function latestEditorModelBoundaryTime(
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
 * Apply editor state from a frame
 */
export const applyFrameState = (
  editor: monaco.editor.IStandaloneCodeEditor,
  frame: EditorFrame,
  decorationsCollection: monaco.editor.IEditorDecorationsCollection | null,
  previousFrame?: EditorFrame | null,
): monaco.editor.IEditorDecorationsCollection | null => {
  if (!frame.state || !isEditorReady(editor)) return decorationsCollection;

  let collection = decorationsCollection;
  // Replay frames are already normalized: recording keyframes by the load and the
  // codec, delta results by applyFrameDelta. A keyframe is the recording's own
  // object, though, so Monaco gets a copy of its view state.
  const { state } = frame;

  try {
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
        editor.restoreViewState(structuredClone(state.viewState));
      } catch (err) {
        console.error("Failed to restore view state:", err);
      }
    }

    applySelectionDiff(editor, state.selection);

    // Add cursor decorations only when Monaco's own caret is not visible. This
    // avoids duplicate carets and preserves native multi-cursor behavior while
    // the editor has text focus.
    if (!editor.hasTextFocus()) {
      // Only update decorations if selection changed or collection is missing
      const selectionChanged =
        !previousFrame || !areSelectionsEqual(previousFrame.state.selection, frame.state.selection);

      if (selectionChanged || viewStateChanged || !collection) {
        const newDecorations: monaco.editor.IModelDeltaDecoration[] = [];
        const currentSelections = editor.getSelections() || [frame.state.selection];

        currentSelections.forEach((selection) => {
          newDecorations.push({
            // Plain IRange (not `new Range(...)`) so this core machine never
            // value-imports monaco-editor; Monaco's decoration API lifts IRange
            // internally. Keeps the 3.7 MB editor chunk out of the eager route
            // graph (it loads lazily with CodeEditor instead).
            range: {
              startLineNumber: selection.positionLineNumber,
              startColumn: selection.positionColumn,
              endLineNumber: selection.positionLineNumber,
              endColumn: selection.positionColumn,
            },
            options: {
              className: "playback-cursor-decoration",
              stickiness: 1, // NeverGrowsWhenTypingAtEdges
              minimap: {
                color: PLAYBACK_CURSOR_COLOR,
                position: 1, // Inline
              },
              overviewRuler: {
                color: PLAYBACK_CURSOR_COLOR,
                position: 2, // Center
              },
            },
          });
        });

        // Create collection if it doesn't exist, otherwise update it
        if (!collection) {
          collection = editor.createDecorationsCollection(newDecorations);
        } else {
          collection.set(newDecorations);
        }
      }
    } else if (collection) {
      collection.clear();
    }
  } catch (error) {
    console.error("Error applying editor state:", error);
  }

  return collection;
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
    slideState.isOpen !== prevSlideState.isOpen ||
    slideState.currentSlideId !== prevSlideState.currentSlideId ||
    slideState.indexv !== prevSlideState.indexv ||
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

  if (frameIndex === lastAppliedFrameIndex) {
    return {};
  }

  const editorModelBoundaryTime = latestEditorModelBoundaryTime(
    recording.workspaceEvents,
    context.lastAppliedWorkspaceEventIndex,
  );

  if (editorModelBoundaryTime !== null && frames[frameIndex].timestamp < editorModelBoundaryTime) {
    return {
      lastAppliedFrameIndex: frameIndex,
      currentFrame: null,
    };
  }

  // A skipped frame leaves no fold at its index for the next tick to build on.
  const frame = foldFrameAtIndex(context, frames, frameIndex);
  if (!frame) {
    return { lastAppliedFrameIndex: frameIndex, currentFrame: null };
  }

  const newCollection = applyFrameState(
    editorRefs.editor,
    frame,
    editorRefs.cursorDecorationsCollection,
    currentFrame,
  );

  const updates: EditorContextUpdate = {
    lastAppliedFrameIndex: frameIndex,
    currentFrame: frame,
  };

  if (newCollection !== editorRefs.cursorDecorationsCollection) {
    updates.editorRefs = {
      ...editorRefs,
      cursorDecorationsCollection: newCollection,
    };
  }

  mirrorFrameSlideState(context, frame, currentFrame);
  const previewState = mirrorFramePreviewState(context, frame);
  if (previewState) {
    updates.lastAppliedPreviewState = previewState;
  }

  return updates;
};

export const clearCursorDecorations = ({ context }: EditorActionArgs): EditorContextUpdate => {
  const { editorRefs } = context;
  if (editorRefs.cursorDecorationsCollection) {
    editorRefs.cursorDecorationsCollection.clear();
  }
  return {
    editorRefs: {
      ...editorRefs,
      cursorDecorationsCollection: null,
    },
  };
};
