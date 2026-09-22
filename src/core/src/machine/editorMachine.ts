import { setup, assign, and, not, stateIn, stopChild, enqueueActions, fromPromise } from "xstate";
import type { EditorMachineContext, EditorMachineEvent, EditorMachineInput } from "./types";
import { createInitialContext } from "./types";
import type { MouseCursorPosition, Recording } from "../types";
import { timelineMachine } from "./timelineMachine";
import { audioRecordingActor, audioPlaybackActor } from "./audioActor";
import { cameraRecordingActor } from "./cameraActor";
import { screenRecordingActor } from "./screenActor";
import { mouseTrackingActor } from "./mouseTrackingActor";
import { calculateDurationFromFileReader } from "../utils/audioDuration";
import {
  APPLY_REPLAY_AFTER_EDITOR_SYNC_ACTIONS,
  APPLY_REPLAY_STATE_ACTIONS,
  getPlaybackAudioState,
  hasSpawnedPlaybackAudio,
  PLAYBACK_END_EPSILON_MS,
  reportMachineError,
  RESET_AND_REATTACH_REPLAY_STATE_ACTIONS,
  SET_EDITOR_REF_ACTIONS,
  shouldRecordCamera,
  syncPlaybackAudio,
  SYNC_PAUSED_WORKSPACE_ACTIONS,
} from "./editorMachineHelpers";
import {
  setCameraRecordingEnabled,
  prepareExternalAudioRecording,
  startExternalAudioPlayback,
  storeExternalAudioDuration,
  stopExternalAudioRecording,
  resetAudioAfterRecorderStop,
  initRecordingSession,
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
  finalizeRecording,
  notifyRecordingStart,
  notifyRecordingStop,
  storeAudioBlob,
  attachLateAudioBlob,
  storeAudioStarted,
  storeCameraBlob,
  captureAudioChunk,
  storeCameraStarted,
  handleCameraError,
  clearCameraRecording,
  handleAudioRecordingError,
  setScreenStream,
  storeScreenStarted,
  notifyScreenRecordingReady,
  clearScreenRecording,
  handleScreenError,
  releaseScreenStream,
  releaseUnacceptedScreenStream,
} from "./captureActions";
import {
  setRecording,
  extendRecording,
  appendRecordingDelta,
  addCaptionTrack,
  removeCaptionTrack,
  applyFrameAtTime,
  seekToTime,
  setPlaybackSpeed,
  setVolume,
  clearCursorDecorations,
  adoptPlaybackWorkspaceAtPause,
  resetPlayback,
  invalidateAppliedPlaybackState,
  detachPlaybackWorkspace,
  reattachPlaybackWorkspace,
  clearPendingPlaybackEditorSync,
  clearPendingEditorSyncForPausedSeek,
  invalidateRenderedPlaybackState,
  clearRecording,
  notifyPlaybackStart,
  notifyPlaybackPause,
  notifyPlaybackEnd,
  notifySeek,
  notifyFrame,
  notifyPlaybackUpdate,
  setEditorRef,
  applyPreviewEventsAtTime,
  applyPreviewPatchBatchesAtTime,
  applyWorkspaceEventsAtTime,
  applyRuntimeEventsAtTime,
  applySlideEventsAtTime,
  applyWhiteboardEventsAtTime,
  applyChatEventsAtTime,
} from "./replayActions";
import { normalizeTimelineDuration, normalizeTimelineTime } from "./playbackValues";
import { isDmpCodecLoaded } from "../../../storage/dmpCodec/dmpCodec";

// ============================================================================
// Editor State Machine
// ============================================================================

export const editorMachine = setup({
  types: {
    context: {} as EditorMachineContext,
    events: {} as EditorMachineEvent,
    input: {} as EditorMachineInput,
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
      const recording = input.recording;
      if (!recording) throw new Error("No recording found to load");
      let duration = normalizeTimelineDuration(recording.duration);

      const playbackAudioState = getPlaybackAudioState(recording);
      if (playbackAudioState?.finalized && recording.audioSource !== "external") {
        try {
          if (recording.audioBlob instanceof Blob) {
            const exactDuration = await calculateDurationFromFileReader(recording.audioBlob);
            // Use audio duration as the source of truth if it exists
            // This prevents trailing silence from wall-clock overhead
            duration = normalizeTimelineDuration(exactDuration * 1000, duration);
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
    isDmpCodecReady: () => isDmpCodecLoaded(),
    canPlay: ({ context }) =>
      context.recording !== null && (context.recording.frames?.length ?? 0) > 0,
    hasExternalAudioBlob: ({ event }) =>
      event.type === "START_RECORDING" &&
      event.audioBlob instanceof Blob &&
      event.audioBlob.size > 0,
    isMicrophoneAudioRecording: ({ context }) =>
      context.enableAudioRecording &&
      context.audio.isRecording &&
      context.audio.source === "microphone",
    isExternalAudioRecording: ({ context }) =>
      context.audio.isRecording && context.audio.source === "external",
    isCameraRecording: ({ context }) => shouldRecordCamera(context),
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
    // Streamed prefixes and late out-of-band media (external audio/camera) must only extend
    // the recording they were decoded from. Each useUrlLoader instance guards staleness only
    // against its own fetches, so a lesson opened another way (header import, drag-and-drop)
    // could otherwise be replaced mid-playback by the previous lesson's late download.
    isSameRecordingStream: ({ context, event }) => {
      if (!context.recording) return false;
      if (event.type === "EXTEND_RECORDING") return event.recording.id === context.recording.id;
      if (event.type === "APPEND_RECORDING_DELTA") {
        return event.delta.recordingId === context.recording.id;
      }
      return false;
    },
    isPlaybackWorkspaceDetached: ({ context }) => context.hasManualWorkspaceOverride,
  },
  actions: {
    // Recording (capture-side) actions — bodies live in captureActions.ts, wrapped
    // here so `setup()` can infer this machine's exact context/event/actor types.
    setCameraRecordingEnabled: assign(setCameraRecordingEnabled),
    prepareExternalAudioRecording: assign(prepareExternalAudioRecording),
    startExternalAudioPlayback: enqueueActions(startExternalAudioPlayback),
    storeExternalAudioDuration: assign(storeExternalAudioDuration),
    stopExternalAudioRecording: assign(stopExternalAudioRecording),
    resetAudioAfterRecorderStop: assign(resetAudioAfterRecorderStop),
    initRecordingSession: assign(initRecordingSession),
    captureInitialFrame: assign(captureInitialFrame),
    captureFrame: assign(captureFrame),
    capturePreviewRefreshFrame: assign(capturePreviewRefreshFrame),
    captureSlideEvent: assign(captureSlideEvent),
    capturePreviewEvent: assign(capturePreviewEvent),
    capturePreviewInitialDocument: assign(capturePreviewInitialDocument),
    capturePreviewPatchBatch: assign(capturePreviewPatchBatch),
    captureWorkspaceEvent: assign(captureWorkspaceEvent),
    captureRuntimeEvent: assign(captureRuntimeEvent),
    captureWhiteboardEvent: assign(captureWhiteboardEvent),
    captureChatEvent: assign(captureChatEvent),
    finalizeRecording: assign(finalizeRecording),
    notifyRecordingStart,
    notifyRecordingStop,
    storeAudioBlob: assign(storeAudioBlob),
    attachLateAudioBlob: assign(attachLateAudioBlob),
    storeAudioStarted: assign(storeAudioStarted),
    storeCameraBlob: assign(storeCameraBlob),
    captureAudioChunk: assign(captureAudioChunk),
    storeCameraStarted: assign(storeCameraStarted),
    handleCameraError: assign(handleCameraError),
    clearCameraRecording: assign(clearCameraRecording),
    handleAudioRecordingError: assign(handleAudioRecordingError),
    setScreenStream: assign(setScreenStream),
    storeScreenStarted: assign(storeScreenStarted),
    notifyScreenRecordingReady,
    clearScreenRecording: assign(clearScreenRecording),
    handleScreenError: assign(handleScreenError),
    releaseScreenStream: assign(releaseScreenStream),
    releaseUnacceptedScreenStream,

    // Playback (replay-side) actions — bodies live in replayActions.ts, wrapped
    // here so `setup()` can infer this machine's exact context/event/actor types.
    setRecording: assign(setRecording),
    extendRecording: assign(extendRecording),
    appendRecordingDelta: assign(appendRecordingDelta),
    addCaptionTrack: assign(addCaptionTrack),
    removeCaptionTrack: assign(removeCaptionTrack),
    applyFrameAtTime: assign(applyFrameAtTime),
    seekToTime: assign(seekToTime),
    setPlaybackSpeed: assign(setPlaybackSpeed),
    setVolume: assign(setVolume),
    clearCursorDecorations: assign(clearCursorDecorations),
    adoptPlaybackWorkspaceAtPause,
    resetPlayback: assign(resetPlayback),
    invalidateAppliedPlaybackState: assign(invalidateAppliedPlaybackState),
    detachPlaybackWorkspace: assign(detachPlaybackWorkspace),
    reattachPlaybackWorkspace: assign(reattachPlaybackWorkspace),
    clearPendingPlaybackEditorSync: assign(clearPendingPlaybackEditorSync),
    clearPendingEditorSyncForPausedSeek: assign(clearPendingEditorSyncForPausedSeek),
    invalidateRenderedPlaybackState: assign(invalidateRenderedPlaybackState),
    clearRecording: assign(clearRecording),
    notifyPlaybackStart,
    notifyPlaybackPause,
    notifyPlaybackEnd,
    notifySeek,
    notifyFrame: assign(notifyFrame),
    notifyPlaybackUpdate,
    setEditorRef: assign(setEditorRef),
    applyPreviewEventsAtTime: assign(applyPreviewEventsAtTime),
    applyPreviewPatchBatchesAtTime: assign(applyPreviewPatchBatchesAtTime),
    applyWorkspaceEventsAtTime: assign(applyWorkspaceEventsAtTime),
    applyRuntimeEventsAtTime: assign(applyRuntimeEventsAtTime),
    applySlideEventsAtTime: assign(applySlideEventsAtTime),
    applyWhiteboardEventsAtTime: assign(applyWhiteboardEventsAtTime),
    applyChatEventsAtTime: assign(applyChatEventsAtTime),
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
        actions: [...APPLY_REPLAY_AFTER_EDITOR_SYNC_ACTIONS],
      },
      {
        actions: [...SET_EDITOR_REF_ACTIONS],
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
    AUDIO_RECORDING_STOPPED: {
      actions: ["attachLateAudioBlob", stopChild("audioRecorder")],
    },
    // Only idle accepts START_RECORDING (its last branch has no guard, so it never bubbles up
    // from there). Anywhere else the event would be dropped along with the display stream the
    // host already acquired and handed over, so release that stream here.
    START_RECORDING: {
      actions: "releaseUnacceptedScreenStream",
    },
    ADD_CAPTION_TRACK: {
      actions: "addCaptionTrack",
    },
    REMOVE_CAPTION_TRACK: {
      actions: "removeCaptionTrack",
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
          stopChild(({ event }) => (event.type === "SCREEN_STOPPED" ? event.actorId : "")),
          "clearScreenRecording",
        ],
      },
      {
        actions: [
          "notifyScreenRecordingReady",
          stopChild(({ event }) => (event.type === "SCREEN_STOPPED" ? event.actorId : "")),
        ],
      },
    ],
    SCREEN_ERROR: [
      {
        guard: "isCurrentScreenRecorderEvent",
        actions: [
          "handleScreenError",
          stopChild(({ event }) => (event.type === "SCREEN_ERROR" ? event.actorId : "")),
        ],
      },
      {
        actions: stopChild(({ event }) => (event.type === "SCREEN_ERROR" ? event.actorId : "")),
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
            guard: not("isDmpCodecReady"),
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
              "notifyFrame",
            ],
          },
          {
            target: "startingRecording",
            guard: ({ context }) => context.enableAudioRecording,
            actions: ["setCameraRecordingEnabled", "setScreenStream"],
          },
          {
            target: "recording",
            actions: [
              "setCameraRecordingEnabled",
              "setScreenStream",
              "initRecordingSession",
              "captureInitialFrame",
              "notifyRecordingStart",
              "notifyFrame",
            ],
          },
        ],
        // A previous take's recorder may still be waiting on its blob; it must not
        // splice that narration into the recording about to load.
        LOAD_RECORDING: {
          target: "loading",
          actions: stopChild("audioRecorder"),
        },
      },
    },

    startingRecording: {
      entry: [
        enqueueActions(({ context, enqueue }) => {
          // A previous take's recorder can outlive its session while it waits on a
          // late blob. Spawning under the same id would only replace the reference
          // and leave the old actor running, so stop it first.
          enqueue.stopChild("audioRecorder");
          // Spawn, not invoke: must survive into recording/stoppingRecording — its
          // AUDIO_RECORDING_STOPPED event arrives after leaving this state.
          enqueue.spawnChild("audioRecording", {
            id: "audioRecorder",
            input: {},
          });
          enqueue.sendTo("audioRecorder", { type: "START" });
          enqueue.assign({
            audio: {
              ...context.audio,
              blob: null,
              isRecording: true,
              chunks: [],
              mimeType: "",
              source: "microphone" as const,
              startOffsetMs: 0,
              externalDurationMs: null,
            },
          });
        }),
      ],
      on: {
        AUDIO_RECORDING_STARTED: {
          target: "recording",
          actions: [
            "storeAudioStarted",
            "initRecordingSession",
            "captureInitialFrame",
            "notifyRecordingStart",
            "notifyFrame",
          ],
        },
        AUDIO_RECORDING_ERROR: {
          target: "idle",
          actions: [
            stopChild("audioRecorder"),
            "resetAudioAfterRecorderStop",
            // gDM ran at click time, so a display stream may be held even though the actor never
            // spawned. Release it here or the browser's "sharing this tab" indicator leaks forever.
            "releaseScreenStream",
            assign({
              error: ({ event }) =>
                event.type === "AUDIO_RECORDING_ERROR" ? event.error : "Failed to start audio",
            }),
            "notifyError",
          ],
        },
        STOP_RECORDING: {
          target: "idle",
          actions: [
            stopChild("audioRecorder"),
            "resetAudioAfterRecorderStop",
            "releaseScreenStream",
          ],
        },
      },
    },

    recording: {
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
      entry: [
        enqueueActions(({ context, enqueue }) => {
          if (!context.enableCameraRecording) return;

          // Spawn, not invoke: conditional on enableCameraRecording.
          enqueue.spawnChild("cameraRecording", {
            id: "cameraRecorder",
            input: {},
          });
          enqueue.sendTo("cameraRecorder", { type: "START" });
          enqueue.assign({
            camera: {
              ...context.camera,
              blob: null,
              isRecording: true,
              mimeType: "",
              source: "camera" as const,
              startOffsetMs: 0,
            },
          });
        }),
        enqueueActions(({ context, enqueue }) => {
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
              startOffsetMs: 0,
            },
          });
        }),
      ],
      exit: [
        stopChild("recordingAudioPlayer"),
        // Every exit from `recording` ends the session (→ stoppingRecording / loading / idle), so
        // this single line stops the screen recorder on all of them — including the external-audio
        // and no-audio paths that bypass `stoppingRecording`. The actor's STOP → onstop → root
        // SCREEN_STOPPED handler then saves the blob (which can land after we've reached playback).
        // Skipped when the user already ended the share early (isRecording cleared on SCREEN_STOPPED).
        enqueueActions(({ context, enqueue }) => {
          if (context.screen.isRecording && context.screen.actorId) {
            enqueue.sendTo(context.screen.actorId, { type: "STOP" });
          }
        }),
      ],
      on: {
        CAPTURE_FRAME: {
          actions: ["captureFrame", "notifyFrame"],
        },
        AUDIO_RECORDING_CHUNK: {
          actions: "captureAudioChunk",
        },
        CAMERA_STARTED: {
          actions: "storeCameraStarted",
        },
        CAMERA_STOPPED: {
          actions: ["storeCameraBlob", stopChild("cameraRecorder")],
        },
        CAMERA_ERROR: {
          actions: ["handleCameraError", stopChild("cameraRecorder")],
        },
        AUDIO_PLAYBACK_READY: {
          actions: "storeExternalAudioDuration",
        },
        // The recorder ended by itself (device unplugged, permission revoked). STOP_RECORDING
        // will then skip `stoppingRecording`, so this is the last place its actor is stopped.
        AUDIO_RECORDING_STOPPED: {
          actions: ["storeAudioBlob", stopChild("audioRecorder")],
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
            actions: ["finalizeRecording", "notifyRecordingStop"],
          },
        ],
        AUDIO_PLAYBACK_ERROR: {
          target: "idle",
          guard: "isExternalAudioRecording",
          actions: [
            stopChild("cameraRecorder"),
            "clearCameraRecording",
            assign({
              error: ({ event }) =>
                event.type === "AUDIO_PLAYBACK_ERROR"
                  ? event.error
                  : "Failed to play external audio",
              audio: () => ({
                url: null,
                blob: null,
                element: null,
                isRecording: false,
                mediaRecorder: null,
                chunks: [],
                mimeType: "",
                source: null,
                startOffsetMs: 0,
                externalDurationMs: null,
              }),
              session: null,
              sessionRevision: 0,
            }),
            "notifyError",
          ],
        },
        AUDIO_RECORDING_ERROR: {
          target: "stoppingRecording",
          guard: "isMicrophoneAudioRecording",
          actions: ["handleAudioRecordingError", "notifyError"],
        },
        SLIDE_EVENT: {
          actions: ["captureSlideEvent", "captureFrame", "notifyFrame"],
        },
        PREVIEW_EVENT: {
          actions: ["capturePreviewEvent", "capturePreviewRefreshFrame", "notifyFrame"],
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
            guard: "isExternalAudioRecording",
            actions: ["finalizeRecording", "notifyRecordingStop"],
          },
          {
            target: "loading",
            actions: ["finalizeRecording", "notifyRecordingStop"],
          },
        ],
      },
    },

    stoppingRecording: {
      entry: [
        enqueueActions(({ context, enqueue }) => {
          if (context.audio.isRecording && context.audio.source === "microphone") {
            enqueue.sendTo("audioRecorder", { type: "STOP" });
          }
          if (shouldRecordCamera(context)) {
            enqueue.sendTo("cameraRecorder", { type: "STOP" });
          }
        }),
      ],
      // The mic recorder is deliberately not stopped on exit. When the watchdog wins, its
      // blob is still on the way, and a stopped actor can no longer deliver it to the root
      // late-blob handler. It is stopped where its blob is consumed instead, or when the
      // take is unloaded or replaced.
      exit: [stopChild("cameraRecorder")],
      on: {
        AUDIO_RECORDING_CHUNK: {
          actions: "captureAudioChunk",
        },
        AUDIO_RECORDING_STOPPED: [
          {
            guard: "isCameraRecording",
            actions: ["storeAudioBlob", stopChild("audioRecorder")],
          },
          {
            target: "loading",
            actions: [
              "storeAudioBlob",
              stopChild("audioRecorder"),
              "finalizeRecording",
              "notifyRecordingStop",
            ],
          },
        ],
        CAMERA_STOPPED: [
          {
            target: "loading",
            guard: ({ context }) => !context.audio.isRecording,
            actions: [
              "storeCameraBlob",
              stopChild("cameraRecorder"),
              "finalizeRecording",
              "notifyRecordingStop",
            ],
          },
          {
            actions: ["storeCameraBlob", stopChild("cameraRecorder")],
          },
        ],
        CAMERA_ERROR: [
          {
            target: "loading",
            guard: ({ context }) => !context.audio.isRecording,
            actions: [
              "handleCameraError",
              stopChild("cameraRecorder"),
              "finalizeRecording",
              "notifyRecordingStop",
            ],
          },
          {
            actions: ["handleCameraError", stopChild("cameraRecorder")],
          },
        ],
        AUDIO_RECORDING_ERROR: {
          actions: ["handleAudioRecordingError", "notifyError"],
        },
      },
      after: {
        2000: {
          target: "loading",
          actions: ["finalizeRecording", "notifyRecordingStop"],
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
          actions: ["setRecording"],
        },
        onError: {
          target: "idle",
          actions: [
            // A mic recorder the finalize watchdog overtook may still be waiting on its blob.
            // With no loaded take to splice it into, it would land in idle's audio slice and
            // ride into the next take, so stop it with the take that failed to load.
            stopChild("audioRecorder"),
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
          actions: stopChild("audioRecorder"),
        },
        UNLOAD: {
          target: "idle",
          actions: [stopChild("audioRecorder"), "clearRecording"],
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
      entry: [
        ...APPLY_REPLAY_STATE_ACTIONS,
        enqueueActions(({ context, enqueue }) => {
          syncPlaybackAudio(context, enqueue, {
            spawnIfMissing: true,
            seek: false,
            syncRate: false,
            syncVolume: false,
            play: false,
          });
        }),
      ],
      exit: [
        stopChild("audioPlayer"),
        "clearCursorDecorations",
        assign({ playbackAudioSpawned: false }),
      ],
      on: {
        WORKSPACE_EVENT: {
          actions: ["detachPlaybackWorkspace"],
        },
        // Streamed growth catches the replay up only while it owns the workspace. Once the
        // viewer has taken over (paused always detaches; ready/ended detach on WORKSPACE_EVENT),
        // detachPlaybackWorkspace has reset the replay cursors, so re-applying would rebuild the
        // recording on top of the viewer's edits. PLAY/SEEK reattach and pick up the new data.
        EXTEND_RECORDING: [
          {
            guard: and(["isSameRecordingStream", "isPlaybackWorkspaceDetached"]),
            actions: ["extendRecording", "syncStreamedRecordingGrowth"],
          },
          {
            guard: "isSameRecordingStream",
            actions: [
              "extendRecording",
              ...APPLY_REPLAY_STATE_ACTIONS,
              "syncStreamedRecordingGrowth",
            ],
          },
        ],
        APPEND_RECORDING_DELTA: [
          {
            guard: and(["isSameRecordingStream", "isPlaybackWorkspaceDetached"]),
            actions: ["appendRecordingDelta", "syncStreamedRecordingGrowth"],
          },
          {
            guard: "isSameRecordingStream",
            actions: [
              "appendRecordingDelta",
              ...APPLY_REPLAY_STATE_ACTIONS,
              "syncStreamedRecordingGrowth",
            ],
          },
        ],
        TICK: {
          actions: [
            assign(({ context, event }) => {
              if (event.type === "TICK") {
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
              }
              return {};
            }),
            ...APPLY_REPLAY_STATE_ACTIONS,
            enqueueActions(({ context, enqueue }) => {
              // Sync audio to timeline every 250ms or on seek
              const lastSync = context.lastSyncTime || 0;
              const now = performance.now();
              if (hasSpawnedPlaybackAudio(context) && now - lastSync > 250) {
                enqueue.sendTo("audioPlayer", {
                  type: "SYNC",
                  timeMs: context.timeline.currentTime,
                });
                enqueue.assign({ lastSyncTime: now });
              }
            }),
            "notifyPlaybackUpdate",
          ],
        },
        SEEK: {
          actions: [
            "reattachPlaybackWorkspace",
            "seekToTime",
            ...APPLY_REPLAY_STATE_ACTIONS,
            "notifySeek",
            "notifyPlaybackUpdate",
            enqueueActions(({ context, event, enqueue }) => {
              const time =
                event.type === "SEEK"
                  ? normalizeTimelineTime(
                      event.time,
                      context.timeline.duration,
                      context.timeline.currentTime,
                    )
                  : context.timeline.currentTime;
              enqueue.sendTo("timelineActor", { type: "SEEK", time });
              if (hasSpawnedPlaybackAudio(context)) {
                enqueue.sendTo("audioPlayer", {
                  type: "SEEK",
                  timeMs: time,
                });
              }
            }),
          ],
        },
        SET_SPEED: {
          actions: [
            "setPlaybackSpeed",
            enqueueActions(({ context, enqueue }) => {
              const speed = context.timeline.speed;
              enqueue.sendTo("timelineActor", { type: "SET_SPEED", speed });
              if (hasSpawnedPlaybackAudio(context)) {
                enqueue.sendTo("audioPlayer", {
                  type: "SET_PLAYBACK_RATE",
                  rate: speed,
                });
              }
            }),
          ],
        },
        SET_VOLUME: {
          actions: [
            "setVolume",
            enqueueActions(({ context, enqueue }) => {
              if (hasSpawnedPlaybackAudio(context)) {
                enqueue.sendTo("audioPlayer", {
                  type: "SET_VOLUME",
                  volume: context.timeline.volume,
                });
              }
            }),
          ],
        },
        STOP: {
          target: ".ready",
          actions: [
            ...RESET_AND_REATTACH_REPLAY_STATE_ACTIONS,
            "notifyPlaybackUpdate",
            enqueueActions(({ context, enqueue }) => {
              enqueue.sendTo("timelineActor", { type: "SEEK", time: 0 });
              if (hasSpawnedPlaybackAudio(context)) {
                enqueue.sendTo("audioPlayer", { type: "SEEK", timeMs: 0 });
              }
            }),
          ],
        },
        // A mic recorder still waiting on its blob after the finalize watchdog belongs to
        // the take being left. Stop it, or its straggler blob would land on whatever
        // comes next.
        UNLOAD: {
          target: "idle",
          actions: [stopChild("audioRecorder"), "clearRecording"],
        },
        // Replace the loaded recording with a newly provided one (file import while a
        // recording is open, or the URL loader's whole-file fallback after a mid-stream
        // reader failure). Exiting `playback` stops the timeline/audio children first.
        LOAD_RECORDING: {
          target: "loading",
          actions: stopChild("audioRecorder"),
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
            ...APPLY_REPLAY_STATE_ACTIONS,
            enqueueActions(({ context, enqueue }) => {
              // Ensure actors are positioned before starting playback. Starting
              // audio first can briefly play stale audio at high speeds, so PLAY
              // is sent after timelineActor START rather than through `play` here.
              //
              // Streaming playback: the audio may have arrived after the recording was first
              // loaded (its bytes are at the end of the stream), so the playback-entry spawn
              // saw no audio. Spawn the player lazily now that audio is available.
              const controllingPlaybackAudio = syncPlaybackAudio(context, enqueue, {
                spawnIfMissing: true,
                seek: true,
                syncRate: true,
                syncVolume: false,
                play: false,
              });

              enqueue.sendTo("timelineActor", {
                type: "SEEK",
                time: context.timeline.currentTime,
              });
              enqueue.sendTo("timelineActor", { type: "START" });
              if (controllingPlaybackAudio) {
                enqueue.sendTo("audioPlayer", { type: "PLAY" });
              }
            }),
            "notifyPlaybackStart",
            "notifyPlaybackUpdate",
          ],
          exit: enqueueActions(({ context, enqueue }) => {
            enqueue.sendTo("timelineActor", { type: "PAUSE" });
            if (hasSpawnedPlaybackAudio(context)) {
              enqueue.sendTo("audioPlayer", { type: "PAUSE" });
            }
          }),
          on: {
            PAUSE: {
              target: "paused",
              actions: "notifyPlaybackPause",
            },
            WORKSPACE_EVENT: {
              target: "paused",
              actions: ["detachPlaybackWorkspace", "notifyPlaybackPause"],
            },
            USER_INTERACTION: {
              target: "paused",
              guard: "shouldPauseOnInteraction",
              actions: "notifyPlaybackPause",
            },
            FINISHED: {
              target: "ended",
              actions: [
                assign({
                  timeline: ({ context }) => ({
                    ...context.timeline,
                    currentTime: context.timeline.duration,
                  }),
                }),
                "notifyPlaybackEnd",
                "notifyPlaybackUpdate",
              ],
            },
          },
        },

        paused: {
          entry: [...SYNC_PAUSED_WORKSPACE_ACTIONS],
          on: {
            // The timeline is paused, so no TICK is expected here. Handling one keeps a
            // stray tick from bubbling up to playback.TICK, which would move the playhead.
            TICK: {
              actions: [...APPLY_REPLAY_STATE_ACTIONS],
            },
            SEEK: {
              actions: [
                "reattachPlaybackWorkspace",
                "clearPendingEditorSyncForPausedSeek",
                "seekToTime",
                ...APPLY_REPLAY_STATE_ACTIONS,
                ...SYNC_PAUSED_WORKSPACE_ACTIONS,
                "notifySeek",
                "notifyPlaybackUpdate",
                enqueueActions(({ context, event, enqueue }) => {
                  const time =
                    event.type === "SEEK"
                      ? normalizeTimelineTime(
                          event.time,
                          context.timeline.duration,
                          context.timeline.currentTime,
                        )
                      : context.timeline.currentTime;
                  enqueue.sendTo("timelineActor", { type: "SEEK", time });
                  if (hasSpawnedPlaybackAudio(context)) {
                    enqueue.sendTo("audioPlayer", {
                      type: "SEEK",
                      timeMs: time,
                    });
                  }
                }),
              ],
            },
            PLAY: {
              target: "playing",
              actions: ["reattachPlaybackWorkspace"],
            },
          },
        },

        ended: {
          on: {
            PLAY: [
              {
                target: "playing",
                guard: ({ context }) =>
                  context.timeline.currentTime >=
                  context.timeline.duration - PLAYBACK_END_EPSILON_MS, // Fuzzy end check
                // Only rewind here. Playing's entry invalidates and re-applies every
                // track at currentTime (now 0), seeks the timeline and audio there and
                // notifies, so doing any of that here too ran every track twice.
                actions: ["reattachPlaybackWorkspace", "resetPlayback"],
              },
              {
                target: "playing",
                actions: ["reattachPlaybackWorkspace"],
              },
            ],
          },
        },
      },
    },
  },
});
