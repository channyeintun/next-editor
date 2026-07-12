import type { EditorMachineContext, EditorMachineEvent } from "./types";
import type { EditorFrame } from "../types";
import { areWorkspaceSnapshotsEqual } from "../../../types/workspace";
import {
  reconstructFrameAtIndex,
  applyFrameDelta,
  findFrameIndexAtTime,
  isKeyframe,
} from "../utils/frameDelta";
import { normalizeEditorFrame, normalizeRecordingData } from "../utils/editorState";
import { isValidFrameState } from "../utils/validation";
import { arePreviewSizesEqual } from "../../../utils/equality";
import {
  getChatReplayResult,
  getPreviewReplayResult,
  getRuntimeReplayResult,
  getSlideReplayResult,
  getWhiteboardReplayResult,
  getWorkspaceReplayResult,
  isSeekReplayEvent,
  resolveReplayTime,
} from "./replayState";
import { applyFrameState, getLoadedRecordingPayload } from "./editorMachineHelpers";

// ============================================================================
// Playback-replay action bodies
//
// Plain functions with the exact shape XState's `assign` callbacks expect,
// specific to the playback/replay side (applying frames/deltas, seeking, tick
// handling, workspace/preview/slide/runtime event replay). editorMachine.ts
// wires each of these into `actions: {}` via `assign(fn)` — kept there
// (rather than wrapped here) so XState's `setup()` can still infer the
// machine's exact context/event/actor types for the wrapped action, which
// isn't independently nameable outside `setup()`. Extracted purely so the
// machine file reads as wiring; zero behavior change.
// ============================================================================

export const setRecording = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  const loaded = getLoadedRecordingPayload(context, event);
  if (!loaded) return {};

  const recording = normalizeRecordingData(loaded.recording);
  const { duration } = loaded;

  const initialWorkspaceEvent = recording.workspaceEvents?.[0];
  const initialRuntimeEvent = recording.runtimeEvents?.[0];

  if (recording.slides && context.applySlides) {
    context.applySlides(recording.slides);
  }

  const currentWorkspaceSnapshot = context.getWorkspaceSnapshot?.() ?? null;

  if (initialWorkspaceEvent && context.applyWorkspaceSnapshot) {
    if (
      !currentWorkspaceSnapshot ||
      !areWorkspaceSnapshotsEqual(currentWorkspaceSnapshot, initialWorkspaceEvent.snapshot)
    ) {
      context.applyWorkspaceSnapshot(initialWorkspaceEvent.snapshot);
    }
  } else if (
    recording.workspaceSnapshot &&
    context.applyWorkspaceSnapshot &&
    (!currentWorkspaceSnapshot ||
      !areWorkspaceSnapshotsEqual(currentWorkspaceSnapshot, recording.workspaceSnapshot))
  ) {
    context.applyWorkspaceSnapshot(recording.workspaceSnapshot);
  }

  if (initialRuntimeEvent && context.applyRuntimeSnapshot) {
    context.applyRuntimeSnapshot(initialRuntimeEvent.snapshot);
  } else if (recording.runtimeSnapshot && context.applyRuntimeSnapshot) {
    context.applyRuntimeSnapshot(recording.runtimeSnapshot);
  }

  // A conversation never pre-exists a recording, so the chat panel always starts
  // empty on load. Resetting here (rather than relying on the first delta) means a
  // recording with no chat events never shows a previous replay's stale transcript
  // — `applyChatEventsAtTime` no-ops for chat-less recordings and would leave it.
  if (context.applyChatSnapshot) {
    context.applyChatSnapshot({ messages: [], status: "idle" });
  }

  return {
    recording,
    hasManualWorkspaceOverride: false,
    pendingPlaybackEditorSync: false,
    playbackAudioSpawned: false,
    timeline: {
      currentTime: 0,
      duration,
      // Speed and volume are player-level settings, not per-recording state:
      // carry them across loads so a playlist auto-advance (or re-record)
      // doesn't yank a viewer back to 1x/full volume mid-session. The audio
      // child is spawned per-load from these context values (syncPlaybackAudio),
      // so the carried values reach it.
      speed: context.timeline.speed,
      volume: context.timeline.volume,
      startedAt: 0,
      pausedDuration: 0,
      pausedAt: 0,
    },
    currentFrame: null,
    lastCallbackFrameTimestamp: undefined,
    lastAppliedFrameIndex: -1,
    lastAppliedPreviewEventIndex: -1,
    lastAppliedPreviewPatchBatchIndex: -1,
    lastAppliedSlideEventIndex: -1,
    lastAppliedWorkspaceEventIndex: initialWorkspaceEvent ? 0 : -1,
    lastAppliedRuntimeEventIndex: initialRuntimeEvent ? 0 : -1,
    lastAppliedWhiteboardEventIndex: -1,
    // Chat has no time-0 seed (a conversation never pre-exists before a recording
    // starts), so it always starts folded from empty — no `initialChatEvent` needed.
    lastAppliedChatEventIndex: -1,
    lastAppliedPreviewState: undefined,
  };
};

// Streaming playback: replace the loaded recording with a longer prefix of the same SCR3
// stream. Because the stream is append-only, the new recording is a superset of the current
// one, so the already-applied playback indices, current time, and timeline stay valid — we
// only swap in the larger frames/events arrays and let the replay cursors catch up.
export const extendRecording = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "EXTEND_RECORDING" || !context.recording) return {};
  // Extended recordings come from the codec (streaming reader / decoder), which
  // already normalized every frame. Re-normalizing here deep-cloned the entire
  // growing frame array on each progressive-decode interval — O(n²) over a
  // long download — for no behavioral difference.
  const recording = event.recording;
  return {
    recording,
    timeline: {
      ...context.timeline,
      duration: Math.max(context.timeline.currentTime, recording.duration),
    },
  };
};

export const applyFrameAtTime = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  const { recording, editorRefs, lastAppliedFrameIndex, currentFrame } = context;
  const currentTime =
    event.type === "TICK"
      ? event.currentTime
      : event.type === "SEEK"
        ? event.time
        : context.timeline.currentTime;

  if (!recording || !editorRefs.editor || context.pendingPlaybackEditorSync) {
    return {};
  }

  const frames = recording.frames;
  if (!frames?.length) return {};

  const frameIndex = findFrameIndexAtTime(frames, currentTime, lastAppliedFrameIndex);

  if (frameIndex === lastAppliedFrameIndex) {
    return {};
  }

  let frame: EditorFrame | null = null;
  const targetFrame = frames[frameIndex];
  const latestWorkspaceEvent =
    recording.workspaceEvents?.[context.lastAppliedWorkspaceEventIndex] ?? null;

  if (latestWorkspaceEvent && targetFrame.timestamp < latestWorkspaceEvent.timestamp) {
    return {
      lastAppliedFrameIndex: frameIndex,
      currentFrame: null,
    };
  }

  if (isKeyframe(targetFrame)) {
    // Keyframe: always use directly, most efficient
    frame = targetFrame;
  } else if (frameIndex === lastAppliedFrameIndex + 1 && currentFrame) {
    // Consecutive delta: apply incrementally
    frame = applyFrameDelta(currentFrame, targetFrame, frameIndex);
  } else {
    // Jump into delta: full reconstruction required
    frame = reconstructFrameAtIndex(frames, frameIndex);
  }

  if (!frame || !frame.state || !isValidFrameState(frame.state)) {
    return { lastAppliedFrameIndex: frameIndex };
  }

  const newCollection = applyFrameState(
    editorRefs.editor,
    frame,
    editorRefs.cursorDecorationsCollection,
    true,
    currentFrame,
  );

  const updates: Partial<EditorMachineContext> = {
    lastAppliedFrameIndex: frameIndex,
    currentFrame: frame,
  };

  if (newCollection !== editorRefs.cursorDecorationsCollection) {
    updates.editorRefs = {
      ...editorRefs,
      cursorDecorationsCollection: newCollection,
    };
  }

  if (
    frame.state.slideState &&
    frame.state.currentSlideIndex !== undefined &&
    context.applySlideState
  ) {
    // Check if this slide state has changed to prevent excessive re-renders
    // We only do this check if we don't have separate slide events
    if (!recording.slideEvents?.length) {
      const prevSlideState = currentFrame?.state.slideState;
      const prevSlideIndex = currentFrame?.state.currentSlideIndex;

      const hasChanged =
        !prevSlideState ||
        frame.state.slideState.isOpen !== prevSlideState.isOpen ||
        frame.state.slideState.currentSlideId !== prevSlideState.currentSlideId ||
        frame.state.slideState.indexv !== prevSlideState.indexv ||
        frame.state.currentSlideIndex !== prevSlideIndex;

      if (hasChanged) {
        context.applySlideState(frame.state.slideState, frame.state.currentSlideIndex);
      }
    }
  }

  if (frame.state.previewState && context.applyPreviewState && !recording.previewEvents?.length) {
    // Dedicated preview events capture preview UI state changes more
    // accurately than editor frames, so only fall back to frame snapshots
    // when no preview event stream exists.
    const nextState = {
      ...frame.state.previewState,
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
      Math.abs((nextState.scrollTop || 0) - (currentState.scrollTop || 0)) > 1 ||
      Math.abs((nextState.scrollLeft || 0) - (currentState.scrollLeft || 0)) > 1
    ) {
      context.applyPreviewState(nextState);
      updates.lastAppliedPreviewState = nextState;
    }
  }

  return updates;
};

export const seekToTime = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "SEEK") return {};
  const clampedTime = Math.max(0, Math.min(event.time, context.timeline.duration));
  return {
    timeline: {
      ...context.timeline,
      currentTime: clampedTime,
    },
    lastAppliedFrameIndex: -1,
    lastAppliedSlideEventIndex: -1,
    lastAppliedPreviewEventIndex: -1,
    lastAppliedPreviewPatchBatchIndex: -1,
    lastAppliedWhiteboardEventIndex: -1,
    // NOTE: `lastAppliedWorkspaceEventIndex` is intentionally NOT reset here.
    // Panel widths (sidebar/preview dock) replay as relative deltas folded
    // into the *live* width, so the net delta is computed between the last
    // applied index and the seek target. Resetting to -1 would re-sum every
    // delta from the start and add it on top of the already-applied width,
    // so repeated seeks make the panels grow/shrink without bound. Keeping
    // the true index lets the replay reverse/advance the exact net delta.
    lastAppliedRuntimeEventIndex: -1,
    lastAppliedChatEventIndex: -1,
  };
};

export const setPlaybackSpeed = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "SET_SPEED") return {};
  return {
    timeline: {
      ...context.timeline,
      speed: event.speed,
    },
  };
};

export const setVolume = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "SET_VOLUME") return {};
  return {
    timeline: {
      ...context.timeline,
      volume: Math.max(0, Math.min(1, event.volume)),
    },
  };
};

export const clearCursorDecorations = ({
  context,
}: {
  context: EditorMachineContext;
}): Partial<EditorMachineContext> => {
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

export const storeRecordedFrameAtPause = ({
  context,
}: {
  context: EditorMachineContext;
}): Partial<EditorMachineContext> => {
  return {
    recordedFrameAtPause: context.currentFrame,
  };
};

export const adoptPlaybackWorkspaceAtPause = ({
  context,
}: {
  context: EditorMachineContext;
}): void => {
  const currentSnapshot = context.getWorkspaceSnapshot?.();
  const activeFilePath = currentSnapshot?.activeFilePath;
  const currentFile = activeFilePath ? currentSnapshot?.project.files[activeFilePath] : undefined;
  const pausedContent = context.currentFrame?.state?.content;

  if (
    !currentSnapshot ||
    !context.applyWorkspaceSnapshot ||
    !activeFilePath ||
    !currentFile ||
    pausedContent === undefined
  ) {
    return;
  }

  if (currentFile.content === pausedContent) {
    context.applyWorkspaceSnapshot(currentSnapshot);
    return;
  }

  context.applyWorkspaceSnapshot({
    ...currentSnapshot,
    project: {
      ...currentSnapshot.project,
      files: {
        ...currentSnapshot.project.files,
        [activeFilePath]: {
          ...currentFile,
          content: pausedContent,
        },
      },
    },
  });
};

export const restoreRecordedFrameFromPause = ({
  context,
}: {
  context: EditorMachineContext;
}): void => {
  const { editorRefs, hasManualWorkspaceOverride, recordedFrameAtPause } = context;
  if (
    hasManualWorkspaceOverride ||
    !editorRefs.editor ||
    !recordedFrameAtPause ||
    !recordedFrameAtPause.state
  ) {
    return;
  }

  // Force restore the exact recorded frame by setting all state directly
  try {
    const normalizedFrame = normalizeEditorFrame(recordedFrameAtPause);
    const model = editorRefs.editor.getModel();
    if (model) {
      model.setValue(normalizedFrame.state.content);
    }
    if (normalizedFrame.state.viewState) {
      editorRefs.editor.restoreViewState(normalizedFrame.state.viewState);
    }
    editorRefs.editor.setPosition(normalizedFrame.state.position);
    editorRefs.editor.setSelection(normalizedFrame.state.selection);
  } catch (error) {
    console.error("Error restoring recorded frame from pause:", error);
  }
};

export const resetPlayback = ({
  context,
}: {
  context: EditorMachineContext;
}): Partial<EditorMachineContext> => ({
  hasManualWorkspaceOverride: false,
  pendingPlaybackEditorSync: false,
  timeline: {
    ...context.timeline,
    currentTime: 0,
    startedAt: 0,
    pausedDuration: 0,
    pausedAt: 0,
  },
  currentFrame: null,
  lastCallbackFrameTimestamp: undefined,
  lastAppliedFrameIndex: -1,
  lastAppliedPreviewEventIndex: -1,
  lastAppliedPreviewPatchBatchIndex: -1,
  lastAppliedSlideEventIndex: -1,
  // `lastAppliedWorkspaceEventIndex` is deliberately omitted here (kept as-is): the
  // relative panel-width deltas rewind from the current index back to the start
  // instead of re-summing from scratch onto the live width. See `seekToTime`.
  lastAppliedRuntimeEventIndex: -1,
  lastAppliedWhiteboardEventIndex: -1,
  lastAppliedChatEventIndex: -1,
  lastAppliedPreviewState: undefined,
});

export const invalidateAppliedPlaybackState = (): Partial<EditorMachineContext> => ({
  currentFrame: null,
  lastCallbackFrameTimestamp: undefined,
  lastAppliedFrameIndex: -1,
  lastAppliedPreviewEventIndex: -1,
  lastAppliedPreviewPatchBatchIndex: -1,
  lastAppliedSlideEventIndex: -1,
  // `lastAppliedWorkspaceEventIndex` is deliberately omitted here (kept as-is) so
  // resuming/replaying does not re-apply the panel-width deltas on top of the
  // already-applied width. See `seekToTime`.
  lastAppliedRuntimeEventIndex: -1,
  lastAppliedWhiteboardEventIndex: -1,
  lastAppliedChatEventIndex: -1,
  lastAppliedPreviewState: undefined,
});

export const detachPlaybackWorkspace = (): Partial<EditorMachineContext> => ({
  hasManualWorkspaceOverride: true,
  pendingPlaybackEditorSync: false,
  currentFrame: null,
  lastAppliedFrameIndex: -1,
  lastAppliedPreviewEventIndex: -1,
  lastAppliedPreviewPatchBatchIndex: -1,
  lastAppliedSlideEventIndex: -1,
  lastAppliedWorkspaceEventIndex: -1,
  lastAppliedRuntimeEventIndex: -1,
  lastAppliedWhiteboardEventIndex: -1,
  lastAppliedChatEventIndex: -1,
  lastAppliedPreviewState: undefined,
});

export const reattachPlaybackWorkspace = ({
  context,
}: {
  context: EditorMachineContext;
}): Partial<EditorMachineContext> => ({
  hasManualWorkspaceOverride: false,
  pendingPlaybackEditorSync: context.hasManualWorkspaceOverride,
});

export const clearPendingPlaybackEditorSync = (): Partial<EditorMachineContext> => ({
  pendingPlaybackEditorSync: false,
});

// Editor/model swaps only invalidate Monaco-rendered frame state. Keep the
// dedicated preview/slide replay cursors stable so file switches do not
// replay their full history.
export const invalidateRenderedPlaybackState = (): Partial<EditorMachineContext> => ({
  currentFrame: null,
  lastAppliedFrameIndex: -1,
});

/**
 * `assign()` property-assigner object (not a function body) — matches the original
 * inline shape so `editorMachine.ts` can pass it straight to `assign(clearRecording)`.
 */
export const clearRecording = {
  hasManualWorkspaceOverride: false,
  pendingPlaybackEditorSync: false,
  recording: null,
  currentFrame: null,
  lastCallbackFrameTimestamp: undefined,
  lastAppliedFrameIndex: -1,
  lastAppliedPreviewEventIndex: -1,
  lastAppliedPreviewPatchBatchIndex: -1,
  lastAppliedSlideEventIndex: -1,
  lastAppliedWorkspaceEventIndex: -1,
  lastAppliedRuntimeEventIndex: -1,
  lastAppliedWhiteboardEventIndex: -1,
  lastAppliedChatEventIndex: -1,
  lastAppliedPreviewState: undefined,
  timeline: ({ context }: { context: EditorMachineContext }) => ({
    ...context.timeline,
    currentTime: 0,
    duration: 0,
  }),
};

export const addCaptionTrack = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "ADD_CAPTION_TRACK" || !context.recording) return {};
  const existing = context.recording.captions ?? [];
  const filtered = existing.filter((t) => t.id !== event.track.id);
  return {
    recording: {
      ...context.recording,
      captions: [...filtered, event.track],
    },
  };
};

export const removeCaptionTrack = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "REMOVE_CAPTION_TRACK" || !context.recording?.captions) return {};
  const filtered = context.recording.captions.filter((t) => t.id !== event.trackId);
  return {
    recording: {
      ...context.recording,
      captions: filtered.length > 0 ? filtered : undefined,
    },
  };
};

export const notifyPlaybackStart = ({ context }: { context: EditorMachineContext }): void => {
  context.onPlaybackStart?.();
};

export const notifyPlaybackPause = ({ context }: { context: EditorMachineContext }): void => {
  context.onPlaybackPause?.();
};

export const notifyPlaybackEnd = ({ context }: { context: EditorMachineContext }): void => {
  context.onPlaybackEnd?.();
};

export const notifySeek = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): void => {
  if (event.type === "SEEK") {
    context.onSeek?.(event.time);
  }
};

export const notifyFrame = ({
  context,
}: {
  context: EditorMachineContext;
}): Partial<EditorMachineContext> => {
  const frame = context.currentFrame;
  if (!frame || context.lastCallbackFrameTimestamp === frame.timestamp) {
    return {};
  }

  context.onFrame?.(frame);
  context.onStateChange?.(frame.state);

  return {
    lastCallbackFrameTimestamp: frame.timestamp,
  };
};

export const notifyPlaybackUpdate = ({ context }: { context: EditorMachineContext }): void => {
  context.onPlaybackUpdate?.(context.timeline.currentTime, context.currentFrame);
};

export const setEditorRef = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "SET_EDITOR_REF") {
    return {};
  }

  const editor = event.editor;
  if (editor === context.editorRefs.editor) {
    return {};
  }

  return {
    editorRefs: {
      ...context.editorRefs,
      editor,
    },
  };
};

export const applyPreviewEventsAtTime = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  const { recording, applyPreviewState, lastAppliedPreviewEventIndex } = context;

  if (!recording?.previewEvents?.length || !applyPreviewState) {
    return {};
  }

  const replayResult = getPreviewReplayResult({
    previewEvents: recording.previewEvents,
    currentTime: resolveReplayTime(event, context.timeline.currentTime),
    lastAppliedIndex: lastAppliedPreviewEventIndex,
    lastAppliedState: context.lastAppliedPreviewState,
    isSeeking: isSeekReplayEvent(event),
  });

  replayResult.appliedStates.forEach((previewState) => {
    applyPreviewState(previewState);
  });

  if (
    replayResult.nextIndex !== lastAppliedPreviewEventIndex ||
    replayResult.retainedState !== context.lastAppliedPreviewState
  ) {
    return {
      lastAppliedPreviewEventIndex: replayResult.nextIndex,
      lastAppliedPreviewState: replayResult.retainedState,
    };
  }

  return {};
};

export const applyPreviewPatchBatchesAtTime = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  const { recording, applyPreviewPatchReplay, lastAppliedPreviewPatchBatchIndex } = context;

  if (
    !recording?.previewPatchBatches?.length ||
    !recording.previewInitialDocuments?.length ||
    !applyPreviewPatchReplay
  ) {
    return {};
  }

  const nextIndex = applyPreviewPatchReplay({
    recordingId: recording.id,
    currentTime: resolveReplayTime(event, context.timeline.currentTime),
    isSeeking: isSeekReplayEvent(event),
    initialDocuments: recording.previewInitialDocuments,
    patchBatches: recording.previewPatchBatches,
    lastAppliedPatchBatchIndex: lastAppliedPreviewPatchBatchIndex,
  });

  if (nextIndex !== lastAppliedPreviewPatchBatchIndex) {
    return {
      lastAppliedPreviewPatchBatchIndex: nextIndex,
    };
  }

  return {};
};

export const applyWorkspaceEventsAtTime = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  const {
    hasManualWorkspaceOverride,
    recording,
    applyWorkspaceSnapshot,
    lastAppliedWorkspaceEventIndex,
  } = context;

  if (hasManualWorkspaceOverride) {
    return {};
  }

  if (!recording?.workspaceEvents?.length || !applyWorkspaceSnapshot) {
    return {};
  }

  const currentWorkspaceSnapshot = context.getWorkspaceSnapshot?.() ?? null;
  const replayResult = getWorkspaceReplayResult({
    workspaceEvents: recording.workspaceEvents,
    currentTime: resolveReplayTime(event, context.timeline.currentTime),
    currentSnapshot: currentWorkspaceSnapshot,
    lastAppliedIndex: lastAppliedWorkspaceEventIndex,
  });

  if (replayResult.snapshotToApply) {
    const activeFileChanged =
      Boolean(currentWorkspaceSnapshot) &&
      currentWorkspaceSnapshot?.activeFilePath !== replayResult.snapshotToApply.activeFilePath;

    applyWorkspaceSnapshot(replayResult.snapshotToApply);
    return {
      lastAppliedWorkspaceEventIndex: replayResult.nextIndex,
      // File switches change the Monaco model path on the React side.
      // Wait for that model sync before applying editor frame content.
      pendingPlaybackEditorSync: activeFileChanged || context.pendingPlaybackEditorSync,
      currentFrame: null,
      lastAppliedFrameIndex: -1,
      lastAppliedSlideEventIndex: -1,
    };
  }

  if (replayResult.nextIndex !== lastAppliedWorkspaceEventIndex) {
    return { lastAppliedWorkspaceEventIndex: replayResult.nextIndex };
  }

  return {};
};

export const applyRuntimeEventsAtTime = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  const { recording, applyRuntimeSnapshot, lastAppliedRuntimeEventIndex } = context;

  if (!recording?.runtimeEvents?.length || !applyRuntimeSnapshot) {
    return {};
  }

  const replayResult = getRuntimeReplayResult({
    runtimeEvents: recording.runtimeEvents,
    currentTime: resolveReplayTime(event, context.timeline.currentTime),
    lastAppliedIndex: lastAppliedRuntimeEventIndex,
  });

  if (replayResult.snapshotToApply) {
    applyRuntimeSnapshot(replayResult.snapshotToApply);
    return { lastAppliedRuntimeEventIndex: replayResult.nextIndex };
  }

  if (replayResult.nextIndex !== lastAppliedRuntimeEventIndex) {
    return { lastAppliedRuntimeEventIndex: replayResult.nextIndex };
  }

  return {};
};

export const applyChatEventsAtTime = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  const { recording, applyChatSnapshot, lastAppliedChatEventIndex } = context;

  if (!recording?.chatEvents?.length || !applyChatSnapshot) {
    return {};
  }

  const replayResult = getChatReplayResult({
    chatEvents: recording.chatEvents,
    currentTime: resolveReplayTime(event, context.timeline.currentTime),
    lastAppliedIndex: lastAppliedChatEventIndex,
  });

  if (replayResult.snapshotToApply) {
    applyChatSnapshot(replayResult.snapshotToApply);
    return { lastAppliedChatEventIndex: replayResult.nextIndex };
  }

  if (replayResult.nextIndex !== lastAppliedChatEventIndex) {
    return { lastAppliedChatEventIndex: replayResult.nextIndex };
  }

  return {};
};

export const applyWhiteboardEventsAtTime = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  const { recording, applyWhiteboardState, lastAppliedWhiteboardEventIndex } = context;

  if (!recording?.whiteboardEvents?.length || !applyWhiteboardState) {
    return {};
  }

  const replayResult = getWhiteboardReplayResult({
    whiteboardEvents: recording.whiteboardEvents,
    currentTime: resolveReplayTime(event, context.timeline.currentTime),
    lastAppliedIndex: lastAppliedWhiteboardEventIndex,
  });

  if (replayResult.stateToApply) {
    applyWhiteboardState(replayResult.stateToApply);
  }

  if (replayResult.nextIndex !== lastAppliedWhiteboardEventIndex) {
    return { lastAppliedWhiteboardEventIndex: replayResult.nextIndex };
  }

  return {};
};

export const applySlideEventsAtTime = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  const { recording, applySlideState, lastAppliedSlideEventIndex } = context;

  if (!recording?.slideEvents?.length || !applySlideState) {
    return {};
  }

  const replayResult = getSlideReplayResult({
    slideEvents: recording.slideEvents,
    slides: recording.slides,
    currentTime: resolveReplayTime(event, context.timeline.currentTime),
    lastAppliedIndex: lastAppliedSlideEventIndex,
    isSeeking: isSeekReplayEvent(event),
  });

  replayResult.applications.forEach((application) => {
    applySlideState(application.slideState, application.slideIndex);
  });

  if (replayResult.nextIndex !== lastAppliedSlideEventIndex) {
    return {
      lastAppliedSlideEventIndex: replayResult.nextIndex,
    };
  }

  return {};
};
