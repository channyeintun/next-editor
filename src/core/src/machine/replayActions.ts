import type {
  EditorActionArgs,
  EditorContextUpdate,
  EditorMachineContext,
  LearnerWorkspaceSave,
} from "./types";
import type { Recording } from "../types";
import type { WorkspaceRecordingSnapshot } from "../workspace";
import {
  areWorkspaceProjectsEqual,
  areWorkspaceSnapshotsEqual,
  isWorkspaceTextFile,
} from "../workspace";
import { normalizeRecordingData } from "../utils/editorState";
import { normalizeChapters } from "../utils/chapters";
import { resolveRuntimeSnapshotAt } from "../runtimeTrack";
import {
  EMPTY_CHAT_CHECKPOINT,
  getChatReplayResult,
  getPreviewReplayResult,
  getRuntimeReplayResult,
  getSlideReplayResult,
  getWhiteboardReplayResult,
  getWorkspaceReplayResult,
  isReplayResync,
} from "./replayState";
import {
  normalizePlaybackSpeed,
  normalizePlaybackVolume,
  normalizeTimelineDuration,
  normalizeTimelineTime,
} from "./playbackValues";
import { applyFrameAtTime, RENDERED_FRAME_RESET } from "./frameReplay";
import { reportMachineError, resolveBoundedReplayTime, type ReplayStep } from "./replayStep";

// ============================================================================
// Playback-replay action bodies
//
// Plain functions with the exact shape XState's `assign` callbacks expect,
// specific to the playback/replay side (loading and streaming the recording in,
// seeking, tick handling, workspace/preview/slide/runtime event replay).
// editorMachine.ts wires each of these into `actions: {}` via `assign(fn)` —
// kept there (rather than wrapped here) so XState's `setup()` can still infer
// the machine's exact context/event/actor types for the wrapped action, which
// isn't independently nameable outside `setup()`.
//
// Siblings: the editor frame replay and Monaco rendering are in frameReplay.ts,
// the narration player's driver in playbackActors.ts, and what the replay steps
// share (reportMachineError, the bounded replay time) in replayStep.ts.
// ============================================================================

/**
 * The replay cursors a seek, rewind, resume or workspace detach resets together, so the
 * next apply re-derives each track at the new time. A new track's cursor belongs here.
 *
 * `lastAppliedWorkspaceEventIndex` is deliberately left out. Panel widths (sidebar/preview
 * dock) replay as relative deltas folded into the *live* width, so the net delta is
 * computed between the last applied index and the target. Resetting it to -1 re-summed
 * every delta from the start on top of the width already applied, so repeated seeks, and
 * every pause/resume (detachPlaybackWorkspace runs on each entry into `paused`), made the
 * panels grow or shrink without bound. Keeping the true index lets the replay reverse or
 * advance the exact net delta. Only loading or clearing a recording resets it.
 */
const REPLAY_CURSORS_RESET = {
  lastAppliedFrameIndex: -1,
  lastAppliedPreviewEventIndex: -1,
  lastAppliedSlideEventIndex: -1,
  lastAppliedRuntimeEventIndex: -1,
  lastAppliedWhiteboardEventIndex: -1,
  lastAppliedChatEventIndex: -1,
} as const satisfies EditorContextUpdate;

/**
 * The replay cursors plus what the last apply rendered: the Monaco frame and the preview
 * state. A seek resets only the cursors: it keeps currentFrame as applyFrameState's Monaco
 * diff base, and the retained preview state for the preview resync. Resetting playback,
 * entering `playing`, detaching the workspace, and loading or clearing a recording also
 * drop what was rendered. A new rendered-state field belongs here.
 */
const APPLIED_PLAYBACK_STATE_RESET = {
  currentFrame: null,
  ...REPLAY_CURSORS_RESET,
  lastAppliedPreviewState: undefined,
} as const satisfies EditorContextUpdate;

/** `loaded` is the `loadRecording` actor's output, passed in by `loading`'s onDone. */
export const setRecording = (
  { context }: Pick<EditorActionArgs, "context">,
  loaded: { recording: Recording; duration: number },
): EditorContextUpdate => {
  const recording = normalizeRecordingData(loaded.recording);
  const duration = normalizeTimelineDuration(loaded.duration);

  // A microphone blob can land while the load actor is in flight — the
  // `stoppingRecording` watchdog finalizes 2s after STOP, so a slower
  // MediaRecorder.stop() misses the snapshot the actor was handed. `finalizeRecording`
  // clears `audio.source`, so a source still set to "microphone" here means exactly
  // that: the root AUDIO_RECORDING_STOPPED handler ran after finalize. Reattach
  // rather than lose the narration — but only onto the take it was recorded for.
  // That flag outlives the take, so an unrelated recording loaded later would
  // otherwise inherit the previous narration.
  if (
    !recording.audioBlob &&
    context.audio.blob &&
    context.audio.source === "microphone" &&
    context.recording?.id === recording.id
  ) {
    recording.audioBlob = context.audio.blob;
    recording.audioSource = "microphone";
    recording.audioStartOffsetMs = recording.audioStartOffsetMs ?? context.audio.startOffsetMs;
  }

  const initialWorkspaceEvent = recording.workspaceEvents?.[0];

  if (recording.slides && context.applySlides) {
    context.applySlides(recording.slides);
  }

  const currentWorkspaceSnapshot = context.getWorkspaceSnapshot?.() ?? null;

  // The workspace track's first snapshot, or the recording's one snapshot when it has no track.
  const initialWorkspaceSnapshot = initialWorkspaceEvent?.snapshot ?? recording.workspaceSnapshot;
  if (
    initialWorkspaceSnapshot &&
    context.applyWorkspaceSnapshot &&
    (!currentWorkspaceSnapshot ||
      !areWorkspaceSnapshotsEqual(currentWorkspaceSnapshot, initialWorkspaceSnapshot))
  ) {
    context.applyWorkspaceSnapshot(initialWorkspaceSnapshot);
  }

  const initialRuntimeSnapshot = recording.runtimeEvents
    ? resolveRuntimeSnapshotAt(recording.runtimeEvents, 0)
    : null;

  // The runtime track's state at 0, or the recording's one snapshot when it has no track.
  const runtimeSnapshot = initialRuntimeSnapshot ?? recording.runtimeSnapshot;
  if (runtimeSnapshot && context.applyRuntimeSnapshot) {
    context.applyRuntimeSnapshot(runtimeSnapshot);
  }

  // Reset to an empty baseline before applying the recording's chat track. A
  // recording that starts with an existing conversation carries it in its first
  // checkpoint; a chat-less recording must not show a previous replay's transcript.
  if (context.applyChatSnapshot) {
    context.applyChatSnapshot(EMPTY_CHAT_CHECKPOINT);
  }

  return {
    recording,
    recordingStreamCursor: 0,
    hasManualWorkspaceOverride: false,
    learnerWorkspaceBaseline: null,
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
    },
    // Every cursor starts before its track's first event (chat folds from the empty
    // transcript applied above), except workspace and runtime, whose first snapshot was
    // applied above. Their overrides follow the spread: the other order would reset them,
    // and the playback entry would apply those snapshots a second time.
    ...APPLIED_PLAYBACK_STATE_RESET,
    lastAppliedWorkspaceEventIndex: initialWorkspaceEvent ? 0 : -1,
    lastAppliedRuntimeEventIndex: initialRuntimeSnapshot ? 0 : -1,
  };
};

function appendRecordsInPlace<T>(
  current: T[] | undefined,
  incoming: readonly T[],
): T[] | undefined {
  if (incoming.length === 0) return current;
  const target = current ?? [];
  for (const record of incoming) target.push(record);
  return target;
}

/**
 * Adds one decoded SCR delta without copying every record reference accumulated so
 * far. The machine owns the arrays created by `setRecording`, so mutating those
 * append-only arrays is safe; a fresh top-level Recording still notifies selectors.
 */
export const appendRecordingDelta = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "APPEND_RECORDING_DELTA" || !context.recording) return {};
  const { delta } = event;
  if (delta.recordingId !== context.recording.id || delta.cursor <= context.recordingStreamCursor) {
    return {};
  }

  const current = context.recording;
  const duration = normalizeTimelineDuration(delta.duration, context.timeline.duration);
  const recording = {
    ...current,
    duration: Math.max(current.duration, duration),
    streamFinalized: current.streamFinalized || delta.streamFinalized,
    frames: appendRecordsInPlace(current.frames, delta.newFrames) ?? current.frames,
    slideEvents: appendRecordsInPlace(current.slideEvents, delta.newSlideEvents),
    previewEvents: appendRecordsInPlace(current.previewEvents, delta.newPreviewEvents),
    previewInitialDocuments: appendRecordsInPlace(
      current.previewInitialDocuments,
      delta.newPreviewInitialDocuments,
    ),
    previewPatchBatches: appendRecordsInPlace(
      current.previewPatchBatches,
      delta.newPreviewPatchBatches,
    ),
    workspaceEvents: appendRecordsInPlace(current.workspaceEvents, delta.newWorkspaceEvents),
    runtimeEvents: appendRecordsInPlace(current.runtimeEvents, delta.newRuntimeEvents),
    cursorEvents: appendRecordsInPlace(current.cursorEvents, delta.newCursorEvents),
    whiteboardEvents: appendRecordsInPlace(current.whiteboardEvents, delta.newWhiteboardEvents),
    chatEvents: appendRecordsInPlace(current.chatEvents, delta.newChatEvents),
  };

  return {
    recording,
    recordingStreamCursor: delta.cursor,
    timeline: {
      ...context.timeline,
      duration: Math.max(context.timeline.currentTime, duration),
    },
  };
};

// Streaming playback: replace the loaded recording with a longer prefix of the same SCR3
// stream. Because the stream is append-only, the new recording is a superset of the current
// one, so the already-applied playback indices, current time, and timeline stay valid — we
// only swap in the larger frames/events arrays and let the replay cursors catch up.
export const extendRecording = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  // The transition is guarded by `isForLoadedRecording` too; this keeps the action itself
  // from ever swapping another lesson in, like `appendRecordingDelta`'s id check.
  if (
    event.type !== "EXTEND_RECORDING" ||
    !context.recording ||
    event.recording.id !== context.recording.id
  ) {
    return {};
  }
  // Extended recordings come from the codec (streaming reader / decoder), which
  // already normalized every frame. Re-normalizing here deep-cloned the entire
  // growing frame array on each progressive-decode interval — O(n²) over a
  // long download — for no behavioral difference.
  //
  // Caption tracks are machine-owned after load: sibling VTTs (useUrlLoader) and viewer
  // imports arrive through ADD_CAPTION_TRACK and are not part of the SCR stream. The small
  // .vtt fetch usually lands before the audio download's extend, which carries only the
  // stream's own captions, so taking its list wholesale dropped the lesson's subtitles.
  //
  // Chapters are machine-owned after load too: they are decoded once from the header, and
  // SET_CHAPTERS is their only writer afterwards. Both senders rebuild the extend from that
  // header, so the loaded copy is never the older one. It is taken as is, without the
  // captions' fallback: a cleared list is `undefined` and must stay cleared.
  const captions = context.recording.captions ?? event.recording.captions;
  const chapters = context.recording.chapters;
  const recording =
    captions === event.recording.captions && chapters === event.recording.chapters
      ? event.recording
      : { ...event.recording, captions, chapters };
  const duration = normalizeTimelineDuration(recording.duration, context.timeline.duration);
  return {
    recording,
    timeline: {
      ...context.timeline,
      duration: Math.max(context.timeline.currentTime, duration),
    },
  };
};

export const seekToTime = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "SEEK") return {};
  const clampedTime = normalizeTimelineTime(
    event.time,
    context.timeline.duration,
    context.timeline.currentTime,
  );
  return {
    timeline: {
      ...context.timeline,
      currentTime: clampedTime,
    },
    ...REPLAY_CURSORS_RESET,
  };
};

/** Moves the playhead to where the timeline actor ticked, clamped to the recording. */
const storeTickTime = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "TICK") return {};
  return {
    timeline: {
      ...context.timeline,
      currentTime: normalizeTimelineTime(
        event.currentTime,
        context.timeline.duration,
        context.timeline.currentTime,
      ),
    },
  };
};

/** The timeline reached the end, so the playhead rests on the recording's last moment. */
export const moveToPlaybackEnd = ({ context }: EditorActionArgs): EditorContextUpdate => ({
  timeline: {
    ...context.timeline,
    currentTime: context.timeline.duration,
  },
});

/** Leaving playback stops the narration player, so the next entry spawns a new one. */
export const clearPlaybackAudioSpawned = (): EditorContextUpdate => ({
  playbackAudioSpawned: false,
});

export const setPlaybackSpeed = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "SET_SPEED") return {};
  return {
    timeline: {
      ...context.timeline,
      speed: normalizePlaybackSpeed(event.speed, context.timeline.speed),
    },
  };
};

export const setVolume = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "SET_VOLUME") return {};
  return {
    timeline: {
      ...context.timeline,
      volume: normalizePlaybackVolume(event.volume, context.timeline.volume),
    },
  };
};

export const adoptPlaybackWorkspaceAtPause = ({ context }: EditorActionArgs): void => {
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

  if (!isWorkspaceTextFile(currentFile) || currentFile.content === pausedContent) {
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

/**
 * Hands the workspace to the viewer (pause, end): remembers it as the recording left
 * it, so `getLearnerWorkspaceSave` can tell the viewer's own edits from the lesson's.
 */
export const captureLearnerWorkspaceBaseline = ({
  context,
}: EditorActionArgs): EditorContextUpdate => ({
  learnerWorkspaceBaseline: context.getWorkspaceSnapshot?.() ?? null,
});

/**
 * The viewer's edits, if the workspace differs from the baseline it was handed, or
 * null. Only the file and folder tree and file contents count: opening a file,
 * collapsing a folder or scrolling is looking around the lesson, not changing it.
 */
export const getLearnerWorkspaceSave = (
  context: EditorMachineContext,
): LearnerWorkspaceSave | null => {
  const baseline = context.learnerWorkspaceBaseline;
  if (!baseline || !context.recording) return null;
  const current = context.getWorkspaceSnapshot?.();
  if (!current || areWorkspaceProjectsEqual(baseline.project, current.project)) return null;
  return {
    recordingId: context.recording.id,
    recordingTime: context.timeline.currentTime,
    snapshot: current,
  };
};

/** Second step of a restore: the paused seek has landed, so lay the saved edits over it. */
export const applyLearnerWorkspace = ({ context, event }: EditorActionArgs): void => {
  if (event.type !== "APPLY_LEARNER_WORKSPACE") return;
  context.applyWorkspaceSnapshot?.(event.snapshot);
};

export const resetPlayback = ({ context }: EditorActionArgs): EditorContextUpdate => ({
  hasManualWorkspaceOverride: false,
  learnerWorkspaceBaseline: null,
  pendingPlaybackEditorSync: false,
  timeline: {
    ...context.timeline,
    currentTime: 0,
  },
  ...APPLIED_PLAYBACK_STATE_RESET,
});

export const invalidateAppliedPlaybackState = (): EditorContextUpdate => ({
  ...APPLIED_PLAYBACK_STATE_RESET,
});

export const detachPlaybackWorkspace = (): EditorContextUpdate => ({
  hasManualWorkspaceOverride: true,
  pendingPlaybackEditorSync: false,
  ...APPLIED_PLAYBACK_STATE_RESET,
});

export const reattachPlaybackWorkspace = ({ context }: EditorActionArgs): EditorContextUpdate => ({
  hasManualWorkspaceOverride: false,
  learnerWorkspaceBaseline: null,
  pendingPlaybackEditorSync: context.hasManualWorkspaceOverride,
});

export const clearPendingPlaybackEditorSync = (): EditorContextUpdate => ({
  pendingPlaybackEditorSync: false,
});

/**
 * A paused SEEK reattaches for that one transition only: SYNC_PAUSED_WORKSPACE_ACTIONS
 * detaches again before anything observes the snapshot, so the playback model never
 * swaps in and no SET_EDITOR_REF arrives to clear the pending sync that
 * `reattachPlaybackWorkspace` just set. Left set, it made `applyFrameAtTime` skip the
 * target frame, so scrubbing a paused lesson moved neither the code nor the caret
 * until PLAY.
 *
 * Clear it only while the viewer is still on the file the recording had open. Frames
 * carry no file path, and the workspace cursor is deliberately not reset on seek
 * (panel-width deltas), so a scrub inside one workspace interval would otherwise write
 * the recorded file's content into a file the viewer opened while paused. A replayed
 * file switch still re-sets the flag in `applyWorkspaceEventsAtTime`.
 */
export const clearPendingEditorSyncForPausedSeek = ({
  context,
}: EditorActionArgs): EditorContextUpdate => {
  const recordedActiveFilePath =
    context.recording?.workspaceEvents?.[context.lastAppliedWorkspaceEventIndex]?.snapshot
      .activeFilePath;
  if (
    recordedActiveFilePath === undefined ||
    context.getWorkspaceSnapshot?.()?.activeFilePath !== recordedActiveFilePath
  ) {
    return {};
  }
  return { pendingPlaybackEditorSync: false };
};

// Editor/model swaps only invalidate Monaco-rendered frame state. Keep the
// dedicated preview/slide replay cursors stable so file switches do not
// replay their full history.
export const invalidateRenderedPlaybackState = (): EditorContextUpdate => ({
  ...RENDERED_FRAME_RESET,
});

export const clearRecording = ({ context }: EditorActionArgs): EditorContextUpdate => ({
  hasManualWorkspaceOverride: false,
  learnerWorkspaceBaseline: null,
  pendingPlaybackEditorSync: false,
  recording: null,
  ...APPLIED_PLAYBACK_STATE_RESET,
  // No recording is left for a width delta to be relative to.
  lastAppliedWorkspaceEventIndex: -1,
  timeline: {
    ...context.timeline,
    currentTime: 0,
    duration: 0,
  },
});

export const addCaptionTrack = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
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

// Chapters sit outside the timeline, like captions: editing them changes nothing else.
export const setChapters = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "SET_CHAPTERS" || !context.recording) return {};
  const chapters = normalizeChapters(event.chapters);
  return {
    recording: { ...context.recording, chapters: chapters.length > 0 ? chapters : undefined },
  };
};

export const notifySeek = ({ context, event }: EditorActionArgs): void => {
  // Runs after seekToTime, which stored the clamped target (or kept the old time for a
  // non-finite one), so the host hears the position playback actually moved to.
  if (event.type === "SEEK") {
    context.onSeek?.(context.timeline.currentTime);
  }
};

export const setEditorRef = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
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

const applyPreviewEventsAtTime = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  const { recording, applyPreviewState, lastAppliedPreviewEventIndex } = context;

  if (!recording?.previewEvents?.length || !applyPreviewState) {
    return {};
  }

  const replayResult = getPreviewReplayResult({
    previewEvents: recording.previewEvents,
    currentTime: resolveBoundedReplayTime(context, event),
    lastAppliedIndex: lastAppliedPreviewEventIndex,
    lastAppliedState: context.lastAppliedPreviewState,
    isResync: isReplayResync(event, lastAppliedPreviewEventIndex),
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

const applyPreviewPatchBatchesAtTime = ({ context, event }: EditorActionArgs): void => {
  const { recording, applyPreviewPatchReplay } = context;

  // An initial document alone is a complete replayable stream (Meta +
  // FullSnapshot), so requiring patch batches too meant a preview that was
  // opened and never mutated replayed as an empty box. Batches without an
  // initial document are not replayable, so that half stays required.
  if (!recording?.previewInitialDocuments?.length || !applyPreviewPatchReplay) {
    return;
  }

  // rrweb replay is driven by time alone, so no cursor comes back to keep.
  applyPreviewPatchReplay({
    recordingId: recording.id,
    currentTime: resolveBoundedReplayTime(context, event),
    initialDocuments: recording.previewInitialDocuments,
    patchBatches: recording.previewPatchBatches ?? [],
  });
};

const applyWorkspaceEventsAtTime = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
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

  // Read at most once per tick, and only if the replay actually needs it — the
  // cursor is unchanged on almost every tick, and reading it walks the workspace.
  let readSnapshot: WorkspaceRecordingSnapshot | null | undefined;
  const currentWorkspaceSnapshot = () => {
    if (readSnapshot === undefined) {
      readSnapshot = context.getWorkspaceSnapshot?.() ?? null;
    }
    return readSnapshot;
  };

  const replayResult = getWorkspaceReplayResult({
    workspaceEvents: recording.workspaceEvents,
    currentTime: resolveBoundedReplayTime(context, event),
    getCurrentSnapshot: currentWorkspaceSnapshot,
    lastAppliedIndex: lastAppliedWorkspaceEventIndex,
  });

  if (replayResult.snapshotToApply) {
    // Already memoized — resolving `snapshotToApply` is what read it.
    const snapshot = currentWorkspaceSnapshot();
    const nextSnapshot = replayResult.snapshotToApply;
    const activeFileChanged =
      Boolean(snapshot) && snapshot?.activeFilePath !== nextSnapshot.activeFilePath;
    // A replayed sidebar scroll or folder toggle leaves the editor's model and its text
    // as they are, so the frame applied on it still stands. Re-deriving it from the
    // nearest keyframe for every scroll event of a burst only redid the same frame.
    const editorUntouched = snapshot
      ? !activeFileChanged && areWorkspaceProjectsEqual(snapshot.project, nextSnapshot.project)
      : false;

    applyWorkspaceSnapshot(nextSnapshot);
    if (editorUntouched) {
      return { lastAppliedWorkspaceEventIndex: replayResult.nextIndex };
    }
    // Only the Monaco-rendered frame depends on the workspace. The slide, preview and
    // other track cursors stay put, so a replayed file switch does not replay their
    // whole history (see invalidateRenderedPlaybackState).
    return {
      lastAppliedWorkspaceEventIndex: replayResult.nextIndex,
      // File switches change the Monaco model path on the React side.
      // Wait for that model sync before applying editor frame content.
      pendingPlaybackEditorSync: activeFileChanged || context.pendingPlaybackEditorSync,
      ...RENDERED_FRAME_RESET,
    };
  }

  if (replayResult.nextIndex !== lastAppliedWorkspaceEventIndex) {
    return { lastAppliedWorkspaceEventIndex: replayResult.nextIndex };
  }

  return {};
};

const applyRuntimeEventsAtTime = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  const { recording, applyRuntimeSnapshot, lastAppliedRuntimeEventIndex } = context;

  if (!recording?.runtimeEvents?.length || !applyRuntimeSnapshot) {
    return {};
  }

  const replayResult = getRuntimeReplayResult({
    runtimeEvents: recording.runtimeEvents,
    currentTime: resolveBoundedReplayTime(context, event),
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

const applyChatEventsAtTime = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  const { recording, applyChatSnapshot, lastAppliedChatEventIndex } = context;

  if (!recording?.chatEvents?.length || !applyChatSnapshot) {
    return {};
  }

  // Same exposure as applyFrameAtTime: the chat fold runs applyChatDelta ->
  // applyContentDelta, which throws on a damaged track — and a throw inside this
  // `assign` stops the actor outright.
  let replayResult;
  try {
    replayResult = getChatReplayResult({
      chatEvents: recording.chatEvents,
      currentTime: resolveBoundedReplayTime(context, event),
      lastAppliedIndex: lastAppliedChatEventIndex,
      isResync: isReplayResync(event, lastAppliedChatEventIndex),
    });
  } catch (error) {
    reportMachineError(
      context,
      error instanceof Error ? error : new Error("Could not replay the recorded agent chat"),
    );
    return { lastAppliedChatEventIndex: recording.chatEvents.length - 1 };
  }

  if (replayResult.snapshotToApply) {
    applyChatSnapshot(replayResult.snapshotToApply);
    return { lastAppliedChatEventIndex: replayResult.nextIndex };
  }

  if (replayResult.nextIndex !== lastAppliedChatEventIndex) {
    return { lastAppliedChatEventIndex: replayResult.nextIndex };
  }

  return {};
};

const applyWhiteboardEventsAtTime = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  const { recording, applyWhiteboardState, lastAppliedWhiteboardEventIndex } = context;

  if (!recording?.whiteboardEvents?.length || !applyWhiteboardState) {
    return {};
  }

  const replayResult = getWhiteboardReplayResult({
    whiteboardEvents: recording.whiteboardEvents,
    currentTime: resolveBoundedReplayTime(context, event),
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

const applySlideEventsAtTime = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  const { recording, applySlideState, lastAppliedSlideEventIndex } = context;

  if (!recording?.slideEvents?.length || !applySlideState) {
    return {};
  }

  const replayResult = getSlideReplayResult({
    slideEvents: recording.slideEvents,
    slides: recording.slides,
    currentTime: resolveBoundedReplayTime(context, event),
    lastAppliedIndex: lastAppliedSlideEventIndex,
    isResync: isReplayResync(event, lastAppliedSlideEventIndex),
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

/**
 * Brings every replayed track to the playhead. The workspace goes first: a replayed file
 * switch holds the editor frame back until the editor has the new model
 * (pendingPlaybackEditorSync).
 */
const REPLAY_STATE_STEPS: readonly ReplayStep[] = [
  applyWorkspaceEventsAtTime,
  applyRuntimeEventsAtTime,
  applyFrameAtTime,
  applyPreviewPatchBatchesAtTime,
  applyPreviewEventsAtTime,
  applySlideEventsAtTime,
  applyWhiteboardEventsAtTime,
  applyChatEventsAtTime,
];

const TICK_REPLAY_STEPS: readonly ReplayStep[] = [storeTickTime, ...REPLAY_STATE_STEPS];

/**
 * Runs `steps` as one `assign`. Each step sees what the ones before it changed and calls its
 * host hooks in the same order, as separate actions did, and their updates merge into one.
 * xstate copies the whole context for every assign, even one that changes nothing (on most
 * ticks no track moves), and V8 copies a context this wide in dictionary mode, about 10 µs
 * each: eight per tick were most of the tick's cost.
 */
function runReplaySteps(
  { context, event }: EditorActionArgs,
  steps: readonly ReplayStep[],
): EditorContextUpdate {
  let stepContext = context;
  let update: EditorContextUpdate | undefined;
  for (const step of steps) {
    const stepUpdate = step({ context: stepContext, event });
    if (!stepUpdate || Object.keys(stepUpdate).length === 0) continue;
    stepContext = { ...stepContext, ...stepUpdate };
    update = { ...update, ...stepUpdate };
  }
  return update ?? {};
}

/** Brings every replayed track to the playhead (REPLAY_STATE_STEPS). */
export const applyReplayStateAtTime = (args: EditorActionArgs): EditorContextUpdate =>
  runReplaySteps(args, REPLAY_STATE_STEPS);

/** A playing TICK: move the playhead to the tick (storeTickTime), then bring every track there. */
export const applyReplayStateAtTick = (args: EditorActionArgs): EditorContextUpdate =>
  runReplaySteps(args, TICK_REPLAY_STEPS);
