import { setup, assign, raise, stateIn, stopChild, enqueueActions, fromPromise } from "xstate";
import type { EditorMachineContext, EditorMachineEvent, EditorMachineInput } from "./types";
import { createIdleCameraState, createInitialContext } from "./types";
import type { MouseCursorPosition, Recording } from "../types";
import { timelineMachine } from "./timelineMachine";
import { audioRecordingActor, audioPlaybackActor } from "./audioActor";
import { cameraRecordingActor } from "./cameraActor";
import { screenRecordingActor } from "./screenActor";
import { mouseTrackingActor } from "./mouseTrackingActor";
import { measureAudioDurationSeconds } from "../utils/audioDuration";
import {
  getExternalAudioBlob,
  getRunningRecorders,
  setCameraRecordingEnabled,
  setMicrophoneDevice,
  prepareExternalAudioRecording,
  startExternalAudioPlayback,
  storeExternalAudioDuration,
  stopExternalAudioRecording,
  resetAudioAfterRecorderStop,
  initRecordingSession,
  captureSlideEvent,
  capturePreviewEvent,
  capturePreviewInitialDocument,
  capturePreviewPatchBatch,
  captureWorkspaceEvent,
  captureRuntimeEvent,
  captureWhiteboardEvent,
  captureChatEvent,
  finalizeRecording,
  notifyRecordingStart,
  notifyRecordingStop,
  storeAudioBlob,
  attachLateAudioBlob,
  storeAudioStarted,
  storeCameraBlob,
  storeCameraStarted,
  handleCameraError,
  clearCameraRecording,
  handleAudioRecordingError,
  handleExternalAudioError,
  pauseRecordingSession,
  resumeRecordingSession,
  addChapterMarker,
} from "./captureActions";
import { captureInitialFrame, captureFrame, capturePreviewRefreshFrame } from "./frameCapture";
import {
  setScreenStream,
  storeScreenStarted,
  notifyScreenRecordingReady,
  clearScreenRecording,
  handleScreenError,
  releaseScreenStream,
  releaseUnacceptedScreenStream,
} from "./screenCaptureActions";
import { findRetakeTargetNow, rewindSessionToSafePoint } from "./retake";
import { appendChatDelta, appendRuntimeRecordingEvent } from "./recordingSession";
import { editRecordedAudio, hasAudioEdit } from "../utils/audioEdit";
import {
  setRecording,
  extendRecording,
  appendRecordingDelta,
  addCaptionTrack,
  setChapters,
  applyReplayStateAtTime,
  applyReplayStateAtTick,
  seekToTime,
  moveToPlaybackEnd,
  clearPlaybackAudioSpawned,
  setPlaybackSpeed,
  setVolume,
  adoptPlaybackWorkspaceAtPause,
  captureLearnerWorkspaceBaseline,
  getLearnerWorkspaceSave,
  applyLearnerWorkspace,
  resetPlayback,
  invalidateAppliedPlaybackState,
  detachPlaybackWorkspace,
  reattachPlaybackWorkspace,
  clearPendingPlaybackEditorSync,
  clearPendingEditorSyncForPausedSeek,
  invalidateRenderedPlaybackState,
  clearRecording,
  notifySeek,
  setEditorRef,
} from "./replayActions";
import { clearCursorDecorations } from "./frameReplay";
import {
  getPlaybackAudioState,
  syncPlaybackAudio,
  seekPlaybackActors,
  spawnPlaybackAudio,
  syncPlaybackAudioToTimeline,
  syncPlaybackActorsSpeed,
  syncPlaybackAudioVolume,
  startPlaybackActors,
  pausePlaybackActors,
} from "./playbackActors";
import { reportMachineError } from "./replayStep";
import { isAtPlaybackEnd, normalizeTimelineDuration } from "./playbackValues";
import { isDmpCodecLoaded } from "../../dmp/dmpCodec";

/**
 * Hands the workspace to the viewer (paused, ended): keep what the recording shows, stop
 * replaying the workspace over it, and remember it as the baseline the viewer's own edits
 * are told apart from.
 */
const SYNC_PAUSED_WORKSPACE_ACTIONS = [
  "adoptPlaybackWorkspaceAtPause",
  "detachPlaybackWorkspace",
  "captureLearnerWorkspaceBaseline",
] as const;

/**
 * A seek while the viewer owns the workspace (paused, ended): keep their edits, take the
 * workspace back for the one step that moves the playhead, then hand it over again.
 * `clearPendingEditorSyncForPausedSeek` holds in `ended` too, since it detaches with the
 * same SYNC_PAUSED_WORKSPACE_ACTIONS and so never swaps in the playback model either.
 */
const SEEK_WHILE_HANDED_OVER_ACTIONS = [
  "preserveLearnerWorkspace",
  "reattachPlaybackWorkspace",
  "clearPendingEditorSyncForPausedSeek",
  "seekToTime",
  "applyReplayStateAtTime",
  ...SYNC_PAUSED_WORKSPACE_ACTIONS,
  "notifySeek",
  "seekPlaybackActors",
] as const;

/** Ends a take: turn the session into the recording, then tell the host it stopped. */
const FINALIZE_TAKE_ACTIONS = ["finalizeRecording", "notifyRecordingStop"] as const;

/**
 * Streamed prefixes and late out-of-band media (external audio/camera, sibling captions)
 * must only reach the recording they were fetched for. useUrlLoader guards staleness only
 * against its own loads (the `?url=` lesson and drops), so a lesson opened another way (the
 * header import) could otherwise be replaced mid-playback by the previous lesson's late
 * download, or be given its subtitles.
 */
function isEventForLoadedRecording({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): boolean {
  if (!context.recording) return false;
  if (event.type === "EXTEND_RECORDING") return event.recording.id === context.recording.id;
  if (event.type === "APPEND_RECORDING_DELTA") {
    return event.delta.recordingId === context.recording.id;
  }
  if (event.type === "ADD_CAPTION_TRACK") return event.recordingId === context.recording.id;
  if (event.type === "SET_CHAPTERS") return event.recordingId === context.recording.id;
  return false;
}

// ============================================================================
// Editor State Machine
// ============================================================================

export const editorMachine = setup({
  types: {
    context: {} as EditorMachineContext,
    events: {} as EditorMachineEvent,
    input: {} as EditorMachineInput,
    // Child id -> actor src. Without it, xstate infers ids only from root-level invokes, so
    // `snapshot.children.timelineActor` (invoked under `playback`) is untyped and a spawn id
    // typo compiles. The screen recorders (dynamic `screenRecorder-N` ids) and the unnamed
    // loadRecording invoke are left out, which keeps their ids plain strings.
    children: {} as {
      timelineActor: "timeline";
      audioPlayer: "audioPlayback";
      recordingAudioPlayer: "audioPlayback";
      audioRecorder: "audioRecording";
      cameraRecorder: "cameraRecording";
      mouseTracker: "mouseTracking";
    },
  },
  actors: {
    timeline: timelineMachine,
    audioRecording: audioRecordingActor,
    cameraRecording: cameraRecordingActor,
    screenRecording: screenRecordingActor,
    audioPlayback: audioPlaybackActor,
    mouseTracking: mouseTrackingActor,
    loadRecording: fromPromise<
      { recording: Recording; duration: number },
      { recording: Recording | null }
    >(async ({ input }) => {
      // Thrown here, not in the invoke's `input`: xstate treats a throwing input as fatal to
      // the whole editor actor, while a rejection reaches `loading.onError`.
      let recording = input.recording;
      if (!recording) throw new Error("No recording found to load");

      // A retake left what it discarded in the narration file, and an edit asks for cuts
      // and mutes. Both are applied here, once the audio is in hand; a microphone blob
      // that has not arrived yet keeps the edit for when it does.
      let editedAudioDurationMs: number | undefined;
      if (hasAudioEdit(recording.pendingAudioEdit) && recording.audioBlob instanceof Blob) {
        try {
          const { blob: audioBlob, durationMs } = await editRecordedAudio(
            recording.audioBlob,
            recording.pendingAudioEdit,
          );
          editedAudioDurationMs = durationMs;
          recording = {
            ...recording,
            audioBlob,
            pendingAudioEdit: undefined,
            tracks: recording.tracks?.map((track) =>
              track.kind === "audio" ? { ...track, mimeType: audioBlob.type } : track,
            ),
          };
        } catch (err) {
          // Keeping the unedited narration is the lesser harm: it still plays, and its
          // stretches before the first cut stay in step.
          console.error("Failed to edit the recording's narration:", err);
          recording = { ...recording, pendingAudioEdit: undefined };
        }
      }

      let duration = normalizeTimelineDuration(recording.duration);

      const playbackAudioState = getPlaybackAudioState(recording);
      if (playbackAudioState?.finalized && recording.audioSource !== "external") {
        try {
          if (recording.audioBlob instanceof Blob) {
            // An edit above already knows its output's length from the samples it
            // encoded, so only an unedited file is decoded to measure it.
            const exactDurationMs =
              editedAudioDurationMs ??
              (await measureAudioDurationSeconds(recording.audioBlob)) * 1000;
            // Use audio duration as the source of truth if it exists
            // This prevents trailing silence from wall-clock overhead
            duration = normalizeTimelineDuration(exactDurationMs, duration);
          }
        } catch (err) {
          console.error("Failed to calculate exact audio duration:", err);
        }
      }

      return { recording: { ...recording, duration }, duration };
    }),
  },
  guards: {
    // Content deltas are built through the diff-match-patch WASM codec, and
    // `getDmpCodec()` throws when it has not loaded. That throw happens inside an
    // xstate `assign` on the capture hot path, which xstate treats as fatal: the
    // actor is stopped mid-recording, every later `send` is a no-op, and the
    // whole in-progress session is lost with only a console message. Refusing to
    // start is the honest outcome — the take would not be encodable at save time
    // either.
    isDmpCodecMissing: () => !isDmpCodecLoaded(),
    canPlay: ({ context }) =>
      context.recording !== null && (context.recording.frames?.length ?? 0) > 0,
    hasExternalAudioBlob: ({ event }) => getExternalAudioBlob(event) !== null,
    isMicrophoneEnabled: ({ context }) => context.enableAudioRecording,
    // The finalize join: no narration and no camera is still recording, so every file the
    // take waits for has arrived (or will never come). stoppingRecording finalizes on it.
    areRecordersDrained: ({ context }) => {
      const running = getRunningRecorders(context);
      return !running.microphone && !running.externalAudio && !running.camera;
    },
    isMicrophoneAudioRecording: ({ context }) =>
      context.enableAudioRecording && getRunningRecorders(context).microphone,
    isExternalAudioRecording: ({ context }) => getRunningRecorders(context).externalAudio,
    isCameraRecording: ({ context }) => getRunningRecorders(context).camera,
    canRetake: ({ context }) =>
      context.session !== null && findRetakeTargetNow(context.session) !== null,
    // A microphone blob that lands after its take finalized (the stop watchdog won) and
    // whose narration still has a retake's cut to apply must go back through loading.
    isLateAudioAwaitingEdit: ({ context }) =>
      hasAudioEdit(context.recording?.pendingAudioEdit) && !context.recording?.audioBlob,
    shouldPauseOnInteraction: ({ context }) => context.pauseOnUserInteraction,
    shouldSyncPlaybackEditorRef: ({ context, event }) =>
      event.type === "SET_EDITOR_REF" &&
      event.editor !== null &&
      !context.hasManualWorkspaceOverride &&
      (context.pendingPlaybackEditorSync ||
        context.currentFrame !== null ||
        context.lastAppliedFrameIndex >= 0),
    isCurrentScreenRecorderEvent: ({ context, event }) =>
      (event.type === "SCREEN_STARTED" ||
        event.type === "SCREEN_STOPPED" ||
        event.type === "SCREEN_ERROR") &&
      context.screen.actorId === event.actorId,
    isForLoadedRecording: isEventForLoadedRecording,
    // Stream growth for the loaded recording after the viewer has taken the workspace over.
    isGrowthWhileViewerOwnsWorkspace: (args) =>
      isEventForLoadedRecording(args) && args.context.hasManualWorkspaceOverride,
    isAtPlaybackEnd: ({ context }) => isAtPlaybackEnd(context.timeline),
  },
  delays: {
    // How long stoppingRecording waits for the recorders' files before it finalizes the
    // take without them. A microphone blob that comes later is still accepted (see the
    // root AUDIO_RECORDING_STOPPED handler).
    recorderStopWatchdog: 2000,
  },
  actions: {
    // Recording (capture-side) actions — bodies live in captureActions.ts,
    // frameCapture.ts and screenCaptureActions.ts, wrapped here so `setup()` can
    // infer this machine's exact context/event/actor types. The ones that only
    // append to the session in place are plain actions: they replace nothing in the
    // context, so an assign would only copy it on every captured event. The recorder
    // actions (start, pause, resume and stop of the microphone, camera and screen
    // recorders) and retakeRecording keep their bodies inline.
    setCameraRecordingEnabled: assign(setCameraRecordingEnabled),
    setMicrophoneDevice: assign(setMicrophoneDevice),
    prepareExternalAudioRecording: assign(prepareExternalAudioRecording),
    startExternalAudioPlayback: enqueueActions(startExternalAudioPlayback),
    storeExternalAudioDuration: assign(storeExternalAudioDuration),
    stopExternalAudioRecording: assign(stopExternalAudioRecording),
    resetAudioAfterRecorderStop: assign(resetAudioAfterRecorderStop),
    initRecordingSession: assign(initRecordingSession),
    captureInitialFrame,
    captureFrame,
    capturePreviewRefreshFrame,
    captureSlideEvent,
    capturePreviewEvent,
    capturePreviewInitialDocument,
    capturePreviewPatchBatch,
    captureWorkspaceEvent,
    captureRuntimeEvent,
    captureWhiteboardEvent,
    captureChatEvent,
    finalizeRecording: assign(finalizeRecording),
    addChapterMarker: assign(addChapterMarker),
    pauseRecordingSession,
    resumeRecordingSession,
    startMicrophoneRecorder: enqueueActions(({ context, enqueue }) => {
      // A previous take's recorder can outlive its session while it waits on a
      // late blob. Spawning under the same id would only replace the reference
      // and leave the old actor running, so stop it first.
      enqueue.stopChild("audioRecorder");
      // Spawn, not invoke: must survive into recording/stoppingRecording — its
      // AUDIO_RECORDING_STOPPED event arrives after leaving this state.
      enqueue.spawnChild("audioRecording", {
        id: "audioRecorder",
        input: { deviceId: context.microphoneDeviceId ?? undefined },
      });
      enqueue.sendTo("audioRecorder", { type: "START" });
      enqueue.assign({
        audio: {
          ...context.audio,
          blob: null,
          isRecording: true,
          mimeType: "",
          source: "microphone" as const,
          startOffsetMs: 0,
          externalDurationMs: null,
        },
      });
    }),
    startCameraRecorder: enqueueActions(({ context, enqueue }) => {
      if (!context.enableCameraRecording) return;

      // Spawn, not invoke: conditional on enableCameraRecording.
      enqueue.spawnChild("cameraRecording", {
        id: "cameraRecorder",
        input: {},
      });
      enqueue.sendTo("cameraRecorder", { type: "START" });
      enqueue.assign({
        camera: { ...createIdleCameraState(), isRecording: true, source: "camera" as const },
      });
    }),
    startScreenRecorder: enqueueActions(({ context, enqueue }) => {
      if (!context.screenStream) return;

      // Spawn the screen recorder with the pre-acquired display stream (it owns it now) plus a
      // *clone* of the live microphone track so narration is muxed into a standalone video. The
      // clone is essential: the actor stops its tracks on teardown, and stopping the original
      // would kill the session's own mic recorder. Absent in external-audio mode (no mic recorder).
      const actorId = context.screen.actorId;
      if (!actorId || !context.session) return;

      const micTrack = context.audio.mediaRecorder?.stream.getAudioTracks()[0]?.clone() ?? null;
      enqueue.spawnChild("screenRecording", {
        id: actorId,
        input: {
          stream: context.screenStream,
          micTrack,
          sessionStartedAtPerf: context.session.startedAtPerf,
        },
      });
      enqueue.sendTo(actorId, { type: "START" });
      enqueue.assign({
        screen: {
          ...context.screen,
          isRecording: true,
          mimeType: "",
        },
      });
    }),
    // The recorders follow the take's clock: each writes nothing while it is paused, so
    // the narration, camera and screen files skip the same spans the timeline does. A
    // selected narration file is an input, not a recording, so it pauses in place.
    pauseRecordingMedia: enqueueActions(({ context, enqueue }) => {
      const running = getRunningRecorders(context);
      if (running.microphone) enqueue.sendTo("audioRecorder", { type: "PAUSE" });
      if (running.externalAudio) enqueue.sendTo("recordingAudioPlayer", { type: "PAUSE" });
      if (running.camera) enqueue.sendTo("cameraRecorder", { type: "PAUSE" });
      if (running.screenActorId) enqueue.sendTo(running.screenActorId, { type: "PAUSE" });
    }),
    resumeRecordingMedia: enqueueActions(({ context, enqueue }) => {
      const running = getRunningRecorders(context);
      if (running.microphone) enqueue.sendTo("audioRecorder", { type: "RESUME" });
      if (running.externalAudio) enqueue.sendTo("recordingAudioPlayer", { type: "PLAY" });
      if (running.camera) enqueue.sendTo("cameraRecorder", { type: "RESUME" });
      if (running.screenActorId) enqueue.sendTo(running.screenActorId, { type: "RESUME" });
    }),
    // Asks the microphone and camera for their files; stoppingRecording waits for them.
    stopRecordingMedia: enqueueActions(({ context, enqueue }) => {
      const running = getRunningRecorders(context);
      if (running.microphone) enqueue.sendTo("audioRecorder", { type: "STOP" });
      if (running.camera) enqueue.sendTo("cameraRecorder", { type: "STOP" });
    }),
    // Every exit from `recording` ends the session (→ stoppingRecording / loading / idle), so
    // this single action stops the screen recorder on all of them — including the external-audio
    // and no-audio paths that bypass `stoppingRecording`. The actor's STOP → onstop → root
    // SCREEN_STOPPED handler then saves the blob (which can land after we've reached playback).
    // Skipped when the user already ended the share early (isRecording cleared on SCREEN_STOPPED).
    stopScreenRecording: enqueueActions(({ context, enqueue }) => {
      const { screenActorId } = getRunningRecorders(context);
      if (screenActorId) enqueue.sendTo(screenActorId, { type: "STOP" });
    }),
    // Rewinds the take to its last safe point and holds it paused there (see retake.ts).
    retakeRecording: enqueueActions(({ context, enqueue }) => {
      const session = context.session;
      if (!session) return;
      const target = findRetakeTargetNow(session);
      if (!target) return;
      const restore = rewindSessionToSafePoint(session, target);

      // The recorders hold still until the take resumes; the stretch they recorded since
      // the safe point is in the session's media cuts. A selected narration file is an
      // input, so it is rewound to be performed over again.
      const running = getRunningRecorders(context);
      if (running.microphone) enqueue.sendTo("audioRecorder", { type: "PAUSE" });
      if (running.externalAudio) {
        enqueue.sendTo("recordingAudioPlayer", { type: "PAUSE" });
        enqueue.sendTo("recordingAudioPlayer", { type: "SEEK", timeMs: target.recordingTime });
      }
      if (running.camera) enqueue.sendTo("cameraRecorder", { type: "PAUSE" });
      if (running.screenActorId) enqueue.sendTo(running.screenActorId, { type: "PAUSE" });

      // The live terminal and agent conversation cannot be rewound. What they show now is
      // recorded whole at the safe point, so what follows is recorded against it.
      if (restore.runtimeChanged) {
        const runtime = context.getRuntimeSnapshot?.();
        if (runtime) appendRuntimeRecordingEvent(session, runtime);
      }
      if (restore.chatChanged) {
        const checkpoint = context.getChatCheckpoint?.();
        if (checkpoint) appendChatDelta(session, { k: "checkpoint", state: checkpoint });
      }

      // The session changed in place. A retake from `paused` lands in `paused` again, a
      // transition that changes no state, so this assign is what publishes a new snapshot
      // for the selectors that read the rewound clock, safe points and chapters.
      enqueue.assign({ session });

      // Put the editor back the way it was at the safe point. These write to the app's
      // stores, whose own capture records any remaining difference at that moment.
      enqueue(() => {
        if (restore.workspace) context.applyWorkspaceSnapshot?.(restore.workspace);
        if (restore.whiteboard) context.applyWhiteboardState?.(restore.whiteboard);
        const state = restore.frame?.state;
        if (state?.slideState) {
          context.applySlideState?.(state.slideState, state.currentSlideIndex ?? 0);
        }
        if (state?.previewState) context.applyPreviewState?.(state.previewState);
        if (restore.previewStreamed) context.requestPreviewCheckpoint?.();
      });
    }),
    notifyRecordingStart,
    notifyRecordingStop,
    storeAudioBlob: assign(storeAudioBlob),
    attachLateAudioBlob: assign(attachLateAudioBlob),
    storeAudioStarted: assign(storeAudioStarted),
    storeCameraBlob: assign(storeCameraBlob),
    storeCameraStarted: assign(storeCameraStarted),
    handleCameraError: assign(handleCameraError),
    clearCameraRecording: assign(clearCameraRecording),
    handleAudioRecordingError: assign(handleAudioRecordingError),
    handleExternalAudioError: assign(handleExternalAudioError),
    setScreenStream: assign(setScreenStream),
    storeScreenStarted: assign(storeScreenStarted),
    notifyScreenRecordingReady,
    clearScreenRecording: assign(clearScreenRecording),
    handleScreenError: assign(handleScreenError),
    releaseScreenStream: assign(releaseScreenStream),
    releaseUnacceptedScreenStream,
    // A stopped child is gone for good; stopping one that is not running does nothing.
    stopAudioRecorder: stopChild("audioRecorder"),
    stopCameraRecorder: stopChild("cameraRecorder"),
    stopRecordingAudioPlayer: stopChild("recordingAudioPlayer"),
    // Every SCREEN_* event names the recorder that sent it, which may belong to an earlier capture.
    stopScreenRecorderFromEvent: stopChild(({ event }) =>
      event.type === "SCREEN_STOPPED" || event.type === "SCREEN_ERROR" ? event.actorId : "",
    ),

    // Playback (replay-side) actions — bodies live in replayActions.ts and
    // frameReplay.ts, wrapped here so `setup()` can infer this machine's exact
    // context/event/actor types. preserveLearnerWorkspace and
    // syncStreamedRecordingGrowth keep their bodies inline.
    extendRecording: assign(extendRecording),
    appendRecordingDelta: assign(appendRecordingDelta),
    addCaptionTrack: assign(addCaptionTrack),
    setChapters: assign(setChapters),
    // Brings every replayed track to the playhead, workspace first, as one assign: the
    // order and why it is one action are at runReplaySteps (replayActions.ts).
    applyReplayStateAtTime: assign(applyReplayStateAtTime),
    applyReplayStateAtTick: assign(applyReplayStateAtTick),
    seekToTime: assign(seekToTime),
    moveToPlaybackEnd: assign(moveToPlaybackEnd),
    clearPlaybackAudioSpawned: assign(clearPlaybackAudioSpawned),
    stopAudioPlayer: stopChild("audioPlayer"),
    setPlaybackSpeed: assign(setPlaybackSpeed),
    setVolume: assign(setVolume),
    clearCursorDecorations: assign(clearCursorDecorations),
    adoptPlaybackWorkspaceAtPause,
    captureLearnerWorkspaceBaseline: assign(captureLearnerWorkspaceBaseline),
    // Before the recording takes the workspace back, hand the viewer's own edits (if
    // any) to the app to keep, and treat what was saved as the new baseline so the
    // same edits are not saved twice.
    preserveLearnerWorkspace: enqueueActions(({ context, enqueue }) => {
      const save = getLearnerWorkspaceSave(context);
      if (!save) return;
      enqueue(() => context.onLearnerWorkspaceSaved?.(save));
      enqueue.assign({ learnerWorkspaceBaseline: save.snapshot });
    }),
    applyLearnerWorkspace,
    resetPlayback: assign(resetPlayback),
    invalidateAppliedPlaybackState: assign(invalidateAppliedPlaybackState),
    detachPlaybackWorkspace: assign(detachPlaybackWorkspace),
    reattachPlaybackWorkspace: assign(reattachPlaybackWorkspace),
    clearPendingPlaybackEditorSync: assign(clearPendingPlaybackEditorSync),
    clearPendingEditorSyncForPausedSeek: assign(clearPendingEditorSyncForPausedSeek),
    invalidateRenderedPlaybackState: assign(invalidateRenderedPlaybackState),
    clearRecording: assign(clearRecording),
    notifySeek,
    setEditorRef: assign(setEditorRef),
    // A longer stream or late media changes the duration, and may be the first usable
    // narration (spawned lazily here), whether or not the replay applied the new records.
    syncStreamedRecordingGrowth: enqueueActions(({ context, enqueue, check }) => {
      enqueue.sendTo("timelineActor", {
        type: "SET_DURATION",
        duration: context.timeline.duration,
      });
      syncPlaybackAudio(context, enqueue, {
        spawnIfMissing: true,
        seek: true,
        syncRate: true,
        syncVolume: true,
        play: check(stateIn({ playback: "playing" })),
      });
    }),
    // Timeline and narration sends — bodies live in playbackActors.ts.
    seekPlaybackActors: enqueueActions(seekPlaybackActors),
    spawnPlaybackAudio: enqueueActions(spawnPlaybackAudio),
    syncPlaybackAudioToTimeline: enqueueActions(syncPlaybackAudioToTimeline),
    syncPlaybackActorsSpeed: enqueueActions(syncPlaybackActorsSpeed),
    syncPlaybackAudioVolume: enqueueActions(syncPlaybackAudioVolume),
    startPlaybackActors: enqueueActions(startPlaybackActors),
    pausePlaybackActors: enqueueActions(pausePlaybackActors),

    // Shared/general — neither pure capture nor pure replay
    clearError: assign({ error: null }),

    setDmpCodecUnavailableError: assign({
      error: "The recording codec could not be loaded. Reload the page and try recording again.",
    }),

    notifyError: ({ context }) => {
      if (context.error) {
        reportMachineError(context, new Error(context.error));
      }
    },
  },
}).createMachine({
  id: "editor",
  context: ({ input }) => createInitialContext(input),

  initial: "idle",
  on: {
    SET_EDITOR_REF: [
      {
        guard: "shouldSyncPlaybackEditorRef",
        actions: [
          "setEditorRef",
          "clearPendingPlaybackEditorSync",
          "invalidateRenderedPlaybackState",
          "applyReplayStateAtTime",
        ],
      },
      {
        actions: ["setEditorRef", "invalidateRenderedPlaybackState"],
      },
    ],
    // The `stoppingRecording` watchdog finalizes 2s after STOP, so a slower
    // MediaRecorder.stop() delivers its blob once the machine has already reached
    // `loading`/`playback`, where the capture-side handlers are gone. That blob is
    // the whole narration — accept it wherever it lands and splice it into the
    // finalized recording. `recording`/`stoppingRecording` keep their own, more
    // specific handlers and take precedence there. The recorder is kept alive past
    // the watchdog precisely so this can happen, so it is stopped here, once its
    // blob is in.
    AUDIO_RECORDING_STOPPED: [
      {
        guard: "isLateAudioAwaitingEdit",
        target: ".loading",
        reenter: true,
        actions: ["attachLateAudioBlob", "stopAudioRecorder"],
      },
      {
        actions: ["attachLateAudioBlob", "stopAudioRecorder"],
      },
    ],
    // Only idle accepts START_RECORDING (its last branch has no guard, so it never bubbles up
    // from there). Anywhere else the event would be dropped along with the display stream the
    // host already acquired and handed over, so release that stream here.
    START_RECORDING: {
      actions: "releaseUnacceptedScreenStream",
    },
    ADD_CAPTION_TRACK: {
      guard: "isForLoadedRecording",
      actions: "addCaptionTrack",
    },
    SET_CHAPTERS: {
      guard: "isForLoadedRecording",
      actions: "setChapters",
    },
    // Screen recording is independent of the session's finalize join: its blob never enters the
    // `Recording`, so these are handled at the machine root and fire in any state. SCREEN_STOPPED
    // may land after the machine has already moved on to `loading`/`playback` or begun another
    // capture. Every completion is delivered, but only the current actor may clear screen context.
    SCREEN_STARTED: {
      guard: "isCurrentScreenRecorderEvent",
      actions: "storeScreenStarted",
    },
    SCREEN_STOPPED: [
      {
        guard: "isCurrentScreenRecorderEvent",
        actions: [
          "notifyScreenRecordingReady",
          "stopScreenRecorderFromEvent",
          "clearScreenRecording",
        ],
      },
      {
        actions: ["notifyScreenRecordingReady", "stopScreenRecorderFromEvent"],
      },
    ],
    SCREEN_ERROR: [
      {
        guard: "isCurrentScreenRecorderEvent",
        actions: ["handleScreenError", "stopScreenRecorderFromEvent"],
      },
      {
        actions: "stopScreenRecorderFromEvent",
      },
    ],
  },
  states: {
    idle: {
      // `error` describes the attempt that failed and sent us back here. It would otherwise
      // outlive every later take, and a host that checks it right after starting one (the
      // studio does) would report that stale failure while the new take is running. Every
      // accepted START_RECORDING and LOAD_RECORDING leaves idle, and a failure of the new
      // attempt is assigned after this exit. The codec refusal stays in idle and keeps its error.
      exit: "clearError",
      on: {
        START_RECORDING: [
          {
            guard: "isDmpCodecMissing",
            actions: [
              "releaseUnacceptedScreenStream",
              "setDmpCodecUnavailableError",
              "notifyError",
            ],
          },
          {
            target: "recording",
            guard: "hasExternalAudioBlob",
            actions: [
              "setCameraRecordingEnabled",
              "setScreenStream",
              "prepareExternalAudioRecording",
              "initRecordingSession",
              "captureInitialFrame",
              "startExternalAudioPlayback",
              "notifyRecordingStart",
            ],
          },
          {
            target: "startingRecording",
            guard: "isMicrophoneEnabled",
            actions: ["setCameraRecordingEnabled", "setMicrophoneDevice", "setScreenStream"],
          },
          {
            target: "recording",
            actions: [
              "setCameraRecordingEnabled",
              "setScreenStream",
              "initRecordingSession",
              "captureInitialFrame",
              "notifyRecordingStart",
            ],
          },
        ],
        // A previous take's recorder may still be waiting on its blob; it must not
        // splice that narration into the recording about to load.
        LOAD_RECORDING: {
          target: "loading",
          actions: "stopAudioRecorder",
        },
      },
    },

    startingRecording: {
      entry: "startMicrophoneRecorder",
      on: {
        AUDIO_RECORDING_STARTED: {
          target: "recording",
          actions: [
            "storeAudioStarted",
            "initRecordingSession",
            "captureInitialFrame",
            "notifyRecordingStart",
          ],
        },
        AUDIO_RECORDING_ERROR: {
          target: "idle",
          actions: [
            "stopAudioRecorder",
            "resetAudioAfterRecorderStop",
            // gDM ran at click time, so a display stream may be held even though the actor never
            // spawned. Release it here or the browser's "sharing this tab" indicator leaks forever.
            "releaseScreenStream",
            "handleAudioRecordingError",
            "notifyError",
          ],
        },
        STOP_RECORDING: {
          target: "idle",
          actions: ["stopAudioRecorder", "resetAudioAfterRecorderStop", "releaseScreenStream"],
        },
      },
    },

    recording: {
      initial: "running",
      invoke: {
        src: "mouseTracking",
        id: "mouseTracker",
        input: ({ self }) => ({
          onMouseMove: (pos: MouseCursorPosition) => {
            self.send({
              type: "CAPTURE_FRAME",
              isMouseMovement: true,
              mousePosition: pos,
            });
          },
        }),
      },
      entry: ["startCameraRecorder", "startScreenRecorder"],
      exit: ["stopRecordingAudioPlayer", "stopScreenRecording"],
      on: {
        CAPTURE_FRAME: {
          actions: "captureFrame",
        },
        // A retake from either substate lands in `paused`: retakeRecording puts the clock
        // back to a safe point and holds it paused there (rewindRecordingClock). It looks
        // for that safe point at the same or a later time than canRetake did, so it always
        // finds one, and the clock and the substate stay in step.
        RETAKE_RECORDING: {
          guard: "canRetake",
          target: ".paused",
          actions: "retakeRecording",
        },
        ADD_CHAPTER_MARKER: {
          actions: "addChapterMarker",
        },
        CAMERA_STARTED: {
          actions: "storeCameraStarted",
        },
        CAMERA_STOPPED: {
          actions: ["storeCameraBlob", "stopCameraRecorder"],
        },
        CAMERA_ERROR: {
          actions: ["handleCameraError", "stopCameraRecorder"],
        },
        AUDIO_PLAYBACK_READY: {
          actions: "storeExternalAudioDuration",
        },
        // The recorder ended by itself (device unplugged, permission revoked). Its file is
        // stored now and `stoppingRecording` will not wait for it, so this is the last place
        // its actor is stopped.
        AUDIO_RECORDING_STOPPED: {
          actions: ["storeAudioBlob", "stopAudioRecorder"],
        },
        AUDIO_PLAYBACK_FINISHED: [
          {
            target: "stoppingRecording",
            guard: "isCameraRecording",
            actions: "stopExternalAudioRecording",
          },
          {
            target: "loading",
            guard: "isExternalAudioRecording",
            actions: FINALIZE_TAKE_ACTIONS,
          },
        ],
        AUDIO_PLAYBACK_ERROR: {
          target: "idle",
          guard: "isExternalAudioRecording",
          actions: [
            "stopCameraRecorder",
            "clearCameraRecording",
            "handleExternalAudioError",
            "notifyError",
          ],
        },
        AUDIO_RECORDING_ERROR: {
          target: "stoppingRecording",
          guard: "isMicrophoneAudioRecording",
          actions: ["handleAudioRecordingError", "notifyError"],
        },
        SLIDE_EVENT: {
          actions: ["captureSlideEvent", "captureFrame"],
        },
        PREVIEW_EVENT: {
          actions: ["capturePreviewEvent", "capturePreviewRefreshFrame"],
        },
        PREVIEW_INITIAL_DOCUMENT: {
          actions: "capturePreviewInitialDocument",
        },
        PREVIEW_PATCH_BATCH: {
          actions: "capturePreviewPatchBatch",
        },
        WORKSPACE_EVENT: {
          actions: "captureWorkspaceEvent",
        },
        RUNTIME_EVENT: {
          actions: "captureRuntimeEvent",
        },
        WHITEBOARD_EVENT: {
          actions: "captureWhiteboardEvent",
        },
        CHAT_EVENT: {
          actions: "captureChatEvent",
        },
        STOP_RECORDING: [
          {
            target: "stoppingRecording",
            guard: "isMicrophoneAudioRecording",
          },
          {
            target: "stoppingRecording",
            guard: "isCameraRecording",
            actions: "stopExternalAudioRecording",
          },
          {
            target: "loading",
            actions: FINALIZE_TAKE_ACTIONS,
          },
        ],
      },
      // A pause stays inside `recording`: every capture handler above keeps running in
      // `paused`, stamped with the paused instant, so edits made while paused are part of
      // the take. The substate and the clock's pausedAt change in the same transitions:
      // every way in starts a new, running clock (initRecordingSession), and only the
      // pause, resume and retake transitions move it.
      states: {
        running: {
          on: {
            PAUSE_RECORDING: {
              target: "paused",
              actions: ["pauseRecordingSession", "pauseRecordingMedia"],
            },
          },
        },
        paused: {
          on: {
            RESUME_RECORDING: {
              target: "running",
              actions: ["resumeRecordingSession", "resumeRecordingMedia"],
            },
          },
        },
      },
    },

    stoppingRecording: {
      entry: "stopRecordingMedia",
      // The mic recorder is deliberately not stopped on exit. When the watchdog wins, its
      // blob is still on the way, and a stopped actor can no longer deliver it to the root
      // late-blob handler. It is stopped where its blob is consumed instead, or when the
      // take is unloaded or replaced.
      exit: "stopCameraRecorder",
      // Each handler only stores what its recorder sent and stops that recorder. Storing a
      // file (or a camera failure) clears that recorder's isRecording flag, and the join
      // below decides when the take has everything.
      on: {
        AUDIO_RECORDING_STOPPED: {
          actions: ["storeAudioBlob", "stopAudioRecorder"],
        },
        CAMERA_STOPPED: {
          actions: ["storeCameraBlob", "stopCameraRecorder"],
        },
        CAMERA_ERROR: {
          actions: ["handleCameraError", "stopCameraRecorder"],
        },
        // A failed microphone keeps its isRecording flag, so such a take ends by the
        // watchdog unless the recorder still sends its file.
        AUDIO_RECORDING_ERROR: {
          actions: ["handleAudioRecordingError", "notifyError"],
        },
      },
      // The finalize join. xstate checks it on entry and after every event this state takes.
      // Today every way in has the microphone or the camera still recording, so it does not
      // pass on entry; if a later way in arrives already drained, finalizing at once is right.
      // A recorder this state waits for must be in areRecordersDrained, and a failed one keeps
      // its isRecording flag so the watchdog, not the join, ends the take. Read only context
      // here: the join is also checked after root events such as SET_EDITOR_REF.
      always: {
        guard: "areRecordersDrained",
        target: "loading",
        actions: FINALIZE_TAKE_ACTIONS,
      },
      after: {
        recorderStopWatchdog: {
          target: "loading",
          actions: FINALIZE_TAKE_ACTIONS,
        },
      },
    },

    loading: {
      invoke: {
        src: "loadRecording",
        input: ({ context, event }) => ({
          recording: event.type === "LOAD_RECORDING" ? event.recording : context.recording,
        }),
        onDone: {
          target: "playback.ready",
          // Inline, not a named setup action: only here is `event` typed as this invoke's
          // done event. Typed params on a named action break the inference of setup's
          // enqueueActions (their action union is inferred with unknown params).
          actions: assign(({ context, event }) => setRecording({ context }, event.output)),
        },
        onError: {
          target: "idle",
          actions: [
            // A mic recorder the finalize watchdog overtook may still be waiting on its blob.
            // With no loaded take to splice it into, it would land in idle's audio slice and
            // ride into the next take, so stop it with the take that failed to load.
            "stopAudioRecorder",
            assign({
              error: ({ event }) =>
                event.error instanceof Error ? event.error.message : "Failed to load recording",
            }),
            "notifyError",
          ],
        },
      },
      // loadRecording decodes the whole narration of a finalized mic take (every STOP, and
      // imports with sibling mic audio), so this state can last seconds. A discard (UNLOAD) or
      // a newer import (LOAD_RECORDING) in that window must not be dropped. Re-entering
      // restarts the invoke with the new event's recording, and the stopped promise actor
      // never delivers its stale result. A recorder the finalize watchdog overtook belongs to
      // the take being left, as in playback's UNLOAD and LOAD_RECORDING.
      on: {
        LOAD_RECORDING: {
          target: "loading",
          reenter: true,
          actions: "stopAudioRecorder",
        },
        UNLOAD: {
          target: "idle",
          actions: ["stopAudioRecorder", "clearRecording"],
        },
      },
    },

    playback: {
      initial: "ready",
      invoke: {
        src: "timeline",
        id: "timelineActor",
        input: ({ context }) => ({
          speed: context.timeline.speed,
          duration: context.timeline.duration,
          startPosition: context.timeline.currentTime,
        }),
      },
      entry: ["applyReplayStateAtTime", "spawnPlaybackAudio"],
      exit: ["stopAudioPlayer", "clearCursorDecorations", "clearPlaybackAudioSpawned"],
      on: {
        WORKSPACE_EVENT: {
          actions: ["detachPlaybackWorkspace"],
        },
        // Streamed growth catches the replay up only while it owns the workspace. Once the
        // viewer has taken over (paused and ended detach on entry; ready detaches on
        // WORKSPACE_EVENT), detachPlaybackWorkspace has reset the replay cursors, so re-applying
        // would rebuild the recording on top of the viewer's edits. PLAY/SEEK reattach and pick
        // up the new data.
        EXTEND_RECORDING: [
          {
            guard: "isGrowthWhileViewerOwnsWorkspace",
            actions: ["extendRecording", "syncStreamedRecordingGrowth"],
          },
          {
            guard: "isForLoadedRecording",
            actions: ["extendRecording", "applyReplayStateAtTime", "syncStreamedRecordingGrowth"],
          },
        ],
        APPEND_RECORDING_DELTA: [
          {
            guard: "isGrowthWhileViewerOwnsWorkspace",
            actions: ["appendRecordingDelta", "syncStreamedRecordingGrowth"],
          },
          {
            guard: "isForLoadedRecording",
            actions: [
              "appendRecordingDelta",
              "applyReplayStateAtTime",
              "syncStreamedRecordingGrowth",
            ],
          },
        ],
        TICK: {
          actions: ["applyReplayStateAtTick", "syncPlaybackAudioToTimeline"],
        },
        SEEK: {
          actions: [
            "reattachPlaybackWorkspace",
            "seekToTime",
            "applyReplayStateAtTime",
            "notifySeek",
            "seekPlaybackActors",
          ],
        },
        SET_SPEED: {
          actions: ["setPlaybackSpeed", "syncPlaybackActorsSpeed"],
        },
        SET_VOLUME: {
          actions: ["setVolume", "syncPlaybackAudioVolume"],
        },
        // resetPlayback already returns the workspace to the recording, so there is no
        // reattach: the frame is applied here, without waiting for SET_EDITOR_REF.
        STOP: {
          target: ".ready",
          actions: [
            "preserveLearnerWorkspace",
            "resetPlayback",
            "applyReplayStateAtTime",
            "seekPlaybackActors",
          ],
        },
        // A mic recorder still waiting on its blob after the finalize watchdog belongs to
        // the take being left. Stop it, or its straggler blob would land on whatever
        // comes next.
        UNLOAD: {
          target: "idle",
          actions: ["preserveLearnerWorkspace", "stopAudioRecorder", "clearRecording"],
        },
        PRESERVE_LEARNER_WORKSPACE: {
          actions: "preserveLearnerWorkspace",
        },
        // Pause (keeping any unsaved edits first), move to where the saved edits were
        // made, then lay them over the recording there. Both steps are raised so they
        // run inside `paused`, after its entry has handed the workspace to the viewer.
        RESTORE_LEARNER_WORKSPACE: {
          target: ".paused",
          actions: [
            "preserveLearnerWorkspace",
            raise(({ event }) => ({ type: "SEEK" as const, time: event.recordingTime })),
            raise(({ event }) => ({
              type: "APPLY_LEARNER_WORKSPACE" as const,
              snapshot: event.snapshot,
            })),
          ],
        },
        // Replace the loaded recording with a newly provided one (file import while a
        // recording is open, or the URL loader's whole-file fallback after a mid-stream
        // reader failure). Exiting `playback` stops the timeline/audio children first.
        LOAD_RECORDING: {
          target: "loading",
          actions: ["preserveLearnerWorkspace", "stopAudioRecorder"],
        },
      },
      states: {
        ready: {
          on: {
            PLAY: {
              target: "playing",
              guard: "canPlay",
              actions: ["reattachPlaybackWorkspace"],
            },
          },
        },

        playing: {
          entry: [
            "invalidateAppliedPlaybackState",
            "applyReplayStateAtTime",
            "startPlaybackActors",
          ],
          exit: "pausePlaybackActors",
          on: {
            PAUSE: {
              target: "paused",
            },
            WORKSPACE_EVENT: {
              target: "paused",
              actions: "detachPlaybackWorkspace",
            },
            USER_INTERACTION: {
              target: "paused",
              guard: "shouldPauseOnInteraction",
            },
            FINISHED: {
              target: "ended",
              actions: "moveToPlaybackEnd",
            },
          },
        },

        paused: {
          entry: [...SYNC_PAUSED_WORKSPACE_ACTIONS],
          on: {
            // The timeline is paused, so no TICK is expected here. Handling one keeps a
            // stray tick from bubbling up to playback.TICK, which would move the playhead.
            TICK: {
              actions: ["applyReplayStateAtTime"],
            },
            SEEK: {
              actions: [...SEEK_WHILE_HANDED_OVER_ACTIONS],
            },
            PLAY: {
              target: "playing",
              actions: ["preserveLearnerWorkspace", "reattachPlaybackWorkspace"],
            },
            APPLY_LEARNER_WORKSPACE: {
              actions: "applyLearnerWorkspace",
            },
          },
        },

        // Like a pause, the end hands the workspace to the viewer: without this the
        // editor stayed on the read-through playback model, so anything typed after the
        // lesson finished never reached the workspace and could be neither run nor kept.
        // A scrub from here keeps those edits too, then hands the workspace over again;
        // it stays in `ended`, so PLAY still decides between restarting and playing on.
        ended: {
          entry: [...SYNC_PAUSED_WORKSPACE_ACTIONS],
          on: {
            SEEK: {
              actions: [...SEEK_WHILE_HANDED_OVER_ACTIONS],
            },
            PLAY: [
              {
                target: "playing",
                guard: "isAtPlaybackEnd",
                // Only rewind here. Playing's entry invalidates and re-applies every
                // track at currentTime (now 0), seeks the timeline and audio there and
                // notifies, so doing any of that here too ran every track twice.
                // resetPlayback also returns the workspace to the recording, so there is
                // no reattach: the frame is applied without waiting for SET_EDITOR_REF.
                actions: ["preserveLearnerWorkspace", "resetPlayback"],
              },
              {
                target: "playing",
                actions: ["preserveLearnerWorkspace", "reattachPlaybackWorkspace"],
              },
            ],
          },
        },
      },
    },
  },
});
