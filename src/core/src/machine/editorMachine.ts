import { setup, assign, stateIn, stopChild, enqueueActions, fromPromise } from "xstate";
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
  APPLY_REPLAY_STATE_AND_STORE_PAUSE_ACTIONS,
  getPlaybackAudioState,
  hasSpawnedPlaybackAudio,
  PLAYBACK_END_EPSILON_MS,
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
  finalizeRecording,
  notifyRecordingStart,
  notifyRecordingStop,
  storeAudioBlob,
  storeAudioStarted,
  storeCameraBlob,
  captureAudioChunk,
  storeCameraStarted,
  handleCameraError,
  setScreenStream,
  storeScreenStarted,
  notifyScreenRecordingReady,
  clearScreenRecording,
  handleScreenError,
  releaseScreenStream,
} from "./captureActions";
import {
  setRecording,
  extendRecording,
  addCaptionTrack,
  removeCaptionTrack,
  applyFrameAtTime,
  seekToTime,
  setPlaybackSpeed,
  setVolume,
  clearCursorDecorations,
  storeRecordedFrameAtPause,
  adoptPlaybackWorkspaceAtPause,
  restoreRecordedFrameFromPause,
  resetPlayback,
  invalidateAppliedPlaybackState,
  detachPlaybackWorkspace,
  reattachPlaybackWorkspace,
  clearPendingPlaybackEditorSync,
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
} from "./replayActions";

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
      { recording: Recording }
    >(async ({ input }) => {
      let duration = input.recording.duration;

      const playbackAudioState = getPlaybackAudioState(input.recording);
      if (playbackAudioState?.finalized && input.recording.audioSource !== "external") {
        try {
          if (input.recording.audioBlob instanceof Blob) {
            const exactDuration = await calculateDurationFromFileReader(input.recording.audioBlob);
            // Use audio duration as the source of truth if it exists
            // This prevents trailing silence from wall-clock overhead
            duration = exactDuration * 1000;
          }
        } catch (err) {
          console.error("Failed to calculate exact audio duration:", err);
        }
      }

      return { recording: { ...input.recording, duration }, duration };
    }),
  },
  guards: {
    canPlay: ({ context }) =>
      context.recording !== null && (context.recording.frames?.length ?? 0) > 0,
    hasExternalAudioBlob: ({ event }) =>
      event.type === "START_RECORDING" && typeof event.audioUrl === "string",
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
    finalizeRecording: assign(finalizeRecording),
    notifyRecordingStart,
    notifyRecordingStop,
    storeAudioBlob: assign(storeAudioBlob),
    storeAudioStarted: assign(storeAudioStarted),
    storeCameraBlob: assign(storeCameraBlob),
    captureAudioChunk: assign(captureAudioChunk),
    storeCameraStarted: assign(storeCameraStarted),
    handleCameraError: assign(handleCameraError),
    setScreenStream: assign(setScreenStream),
    storeScreenStarted: assign(storeScreenStarted),
    notifyScreenRecordingReady,
    clearScreenRecording: assign(clearScreenRecording),
    handleScreenError: assign(handleScreenError),
    releaseScreenStream: assign(releaseScreenStream),

    // Playback (replay-side) actions — bodies live in replayActions.ts, wrapped
    // here so `setup()` can infer this machine's exact context/event/actor types.
    setRecording: assign(setRecording),
    extendRecording: assign(extendRecording),
    addCaptionTrack: assign(addCaptionTrack),
    removeCaptionTrack: assign(removeCaptionTrack),
    applyFrameAtTime: assign(applyFrameAtTime),
    seekToTime: assign(seekToTime),
    setPlaybackSpeed: assign(setPlaybackSpeed),
    setVolume: assign(setVolume),
    clearCursorDecorations: assign(clearCursorDecorations),
    storeRecordedFrameAtPause: assign(storeRecordedFrameAtPause),
    adoptPlaybackWorkspaceAtPause,
    restoreRecordedFrameFromPause,
    resetPlayback: assign(resetPlayback),
    invalidateAppliedPlaybackState: assign(invalidateAppliedPlaybackState),
    detachPlaybackWorkspace: assign(detachPlaybackWorkspace),
    reattachPlaybackWorkspace: assign(reattachPlaybackWorkspace),
    clearPendingPlaybackEditorSync: assign(clearPendingPlaybackEditorSync),
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

    // Shared/general — neither pure capture nor pure replay
    setError: assign(({ event }) => {
      if (event.type !== "LOAD_FAILED") return {};
      return { error: event.error };
    }),

    clearError: assign({ error: null }),

    notifyError: ({ context }) => {
      if (context.error) {
        context.onError?.(new Error(context.error));
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
    ADD_CAPTION_TRACK: {
      actions: "addCaptionTrack",
    },
    REMOVE_CAPTION_TRACK: {
      actions: "removeCaptionTrack",
    },
    // Screen recording is independent of the session's finalize join: its blob never enters the
    // `Recording`, so these are handled at the machine root and fire in any state. SCREEN_STOPPED
    // may land after the machine has already moved on to `loading`/`playback` — that's fine, the
    // root handler saves the blob and clears context whenever it arrives.
    SCREEN_STARTED: {
      actions: "storeScreenStarted",
    },
    SCREEN_STOPPED: {
      actions: ["notifyScreenRecordingReady", stopChild("screenRecorder"), "clearScreenRecording"],
    },
    SCREEN_ERROR: {
      actions: ["handleScreenError", stopChild("screenRecorder")],
    },
  },
  states: {
    idle: {
      on: {
        START_RECORDING: [
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
        LOAD_RECORDING: "loading",
      },
    },

    startingRecording: {
      entry: [
        enqueueActions(({ context, enqueue }) => {
          // Spawn, not invoke: must survive into recording/stoppingRecording — its
          // STOPPED event arrives after leaving this state.
          enqueue.spawnChild("audioRecording", {
            id: "audioRecorder",
            input: {
              constraints: {
                autoGainControl: true,
                echoCancellation: true,
                noiseSuppression: true,
              },
            },
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
        STARTED: {
          target: "recording",
          actions: [
            "storeAudioStarted",
            "initRecordingSession",
            "captureInitialFrame",
            "notifyRecordingStart",
            "notifyFrame",
          ],
        },
        ERROR: {
          target: "idle",
          actions: [
            stopChild("audioRecorder"),
            "resetAudioAfterRecorderStop",
            // gDM ran at click time, so a display stream may be held even though the actor never
            // spawned. Release it here or the browser's "sharing this tab" indicator leaks forever.
            "releaseScreenStream",
            assign({
              error: ({ event }) =>
                event.type === "ERROR" ? event.error : "Failed to start audio",
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
          const micTrack = context.audio.mediaRecorder?.stream.getAudioTracks()[0]?.clone() ?? null;
          enqueue.spawnChild("screenRecording", {
            id: "screenRecorder",
            input: { stream: context.screenStream, micTrack },
          });
          enqueue.sendTo("screenRecorder", { type: "START" });
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
          if (context.screen.isRecording) {
            enqueue.sendTo("screenRecorder", { type: "STOP" });
          }
        }),
      ],
      on: {
        CAPTURE_FRAME: {
          actions: ["captureFrame", "notifyFrame"],
        },
        CHUNK: {
          actions: "captureAudioChunk",
        },
        CAMERA_STARTED: {
          actions: "storeCameraStarted",
        },
        CAMERA_STOPPED: {
          actions: "storeCameraBlob",
        },
        CAMERA_ERROR: {
          actions: "handleCameraError",
        },
        READY: {
          actions: "storeExternalAudioDuration",
        },
        STOPPED: {
          actions: "storeAudioBlob",
        },
        FINISHED: [
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
        ERROR: {
          target: "idle",
          guard: "isExternalAudioRecording",
          actions: [
            assign({
              error: ({ event }) =>
                event.type === "ERROR" ? event.error : "Failed to play external audio",
              audio: ({ context }) => ({
                ...context.audio,
                isRecording: false,
                source: null,
                externalDurationMs: null,
              }),
              session: null,
              sessionRevision: 0,
            }),
            "notifyError",
          ],
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
      exit: [stopChild("audioRecorder"), stopChild("cameraRecorder")],
      on: {
        CHUNK: {
          actions: "captureAudioChunk",
        },
        STOPPED: [
          {
            guard: "isCameraRecording",
            actions: "storeAudioBlob",
          },
          {
            target: "loading",
            actions: ["storeAudioBlob", "finalizeRecording", "notifyRecordingStop"],
          },
        ],
        CAMERA_STOPPED: [
          {
            target: "loading",
            guard: ({ context }) => !context.audio.isRecording,
            actions: ["storeCameraBlob", "finalizeRecording", "notifyRecordingStop"],
          },
          {
            actions: "storeCameraBlob",
          },
        ],
        CAMERA_ERROR: {
          actions: "handleCameraError",
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
        input: ({ context, event }) => {
          if (event.type === "LOAD_RECORDING") return { recording: event.recording };
          if (context.recording) return { recording: context.recording };
          throw new Error("No recording found to load");
        },
        onDone: {
          target: "playback.ready",
          actions: ["setRecording"],
        },
        onError: {
          target: "idle",
          actions: [
            assign({
              error: ({ event }) =>
                event.error instanceof Error ? event.error.message : "Failed to load recording",
            }),
            "notifyError",
          ],
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
        EXTEND_RECORDING: {
          actions: [
            "extendRecording",
            ...APPLY_REPLAY_STATE_ACTIONS,
            enqueueActions(({ context, event, enqueue, check }) => {
              if (event.type !== "EXTEND_RECORDING") {
                return;
              }

              enqueue.sendTo("timelineActor", {
                type: "SET_DURATION",
                duration: Math.max(context.timeline.currentTime, event.recording.duration),
              });

              syncPlaybackAudio(context, enqueue, {
                spawnIfMissing: true,
                seek: true,
                syncRate: true,
                syncVolume: true,
                play: check(stateIn({ playback: "playing" })),
              });
            }),
          ],
        },
        TICK: {
          actions: [
            assign(({ context, event }) => {
              if (event.type === "TICK") {
                return {
                  timeline: {
                    ...context.timeline,
                    currentTime: event.currentTime,
                  },
                };
              }
              return {};
            }),
            ...APPLY_REPLAY_STATE_ACTIONS,
            enqueueActions(({ context, event, enqueue }) => {
              // Sync audio to timeline every 250ms or on seek
              const lastSync = context.lastSyncTime || 0;
              const now = performance.now();
              if (hasSpawnedPlaybackAudio(context) && now - lastSync > 250) {
                enqueue.sendTo("audioPlayer", {
                  type: "SYNC",
                  timeMs: event.currentTime,
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
              const time = event.type === "SEEK" ? event.time : 0;
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
            enqueueActions(({ context, event, enqueue }) => {
              const speed = event.type === "SET_SPEED" ? event.speed : 1;
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
            enqueueActions(({ context, event, enqueue }) => {
              if (hasSpawnedPlaybackAudio(context)) {
                enqueue.sendTo("audioPlayer", {
                  type: "SET_VOLUME",
                  volume: event.type === "SET_VOLUME" ? event.volume : 1,
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
        UNLOAD: {
          target: "idle",
          actions: "clearRecording",
        },
        // Replace the loaded recording with a newly provided one (file import while a
        // recording is open, or the URL loader's whole-file fallback after a mid-stream
        // reader failure). Exiting `playback` stops the timeline/audio children first.
        LOAD_RECORDING: {
          target: "loading",
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
            TICK: {
              actions: [...APPLY_REPLAY_STATE_AND_STORE_PAUSE_ACTIONS],
            },
            SEEK: {
              actions: [
                "reattachPlaybackWorkspace",
                "seekToTime",
                ...APPLY_REPLAY_STATE_ACTIONS,
                ...SYNC_PAUSED_WORKSPACE_ACTIONS,
                "notifySeek",
                "notifyPlaybackUpdate",
                enqueueActions(({ context, event, enqueue }) => {
                  const time = event.type === "SEEK" ? event.time : 0;
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
              actions: ["restoreRecordedFrameFromPause", "reattachPlaybackWorkspace"],
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
                actions: [
                  "reattachPlaybackWorkspace",
                  "resetPlayback",
                  ...APPLY_REPLAY_STATE_ACTIONS,
                  "notifyPlaybackUpdate",
                  enqueueActions(({ context, enqueue }) => {
                    enqueue.sendTo("timelineActor", { type: "SEEK", time: 0 });
                    if (hasSpawnedPlaybackAudio(context)) {
                      enqueue.sendTo("audioPlayer", { type: "SEEK", timeMs: 0 });
                    }
                  }),
                ],
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
