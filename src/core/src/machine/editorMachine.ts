import { setup, assign, spawnChild, stopChild, enqueueActions, fromPromise } from "xstate";
import type { EditorMachineContext, EditorMachineEvent, EditorMachineInput } from "./types";
import { createInitialContext } from "./types";
import type { MouseCursorPosition, Recording } from "../types";
import { timelineMachine } from "./timelineMachine";
import { audioRecordingActor, audioPlaybackActor } from "./audioActor";
import { cameraRecordingActor } from "./cameraActor";
import { mouseTrackingActor } from "./mouseTrackingActor";
import { calculateDurationFromFileReader } from "../utils/audioDuration";
import {
  APPLY_REPLAY_AFTER_EDITOR_SYNC_ACTIONS,
  APPLY_REPLAY_STATE_ACTIONS,
  APPLY_REPLAY_STATE_AND_STORE_PAUSE_ACTIONS,
  getPlaybackAudioState,
  hasPlaybackAudio,
  hasSpawnedPlaybackAudio,
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
  initRecordingSession,
  captureInitialFrame,
  captureFrame,
  capturePreviewRefreshFrame,
  finalizeRecording,
  notifyRecordingStart,
  notifyRecordingStop,
  storeAudioBlob,
  storeAudioStarted,
  storeCameraBlob,
  captureAudioChunk,
  storeCameraStarted,
  handleCameraError,
} from "./captureActions";
import {
  setRecording,
  extendRecording,
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
} from "./replayActions";
import {
  appendPreviewInitialDocument,
  appendPreviewPatchBatch,
  appendPreviewRecordingEvent,
  appendRuntimeRecordingEvent,
  appendSlideRecordingEvent,
  appendWorkspaceRecordingEvent,
} from "./recordingSession";

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
          const exactDuration = await calculateDurationFromFileReader(playbackAudioState.blob);
          // Use audio duration as the source of truth if it exists
          // This prevents trailing silence from wall-clock overhead
          duration = exactDuration * 1000;
        } catch (err) {
          console.error("Failed to calculate exact audio duration:", err);
        }
      }

      return { recording: { ...input.recording, duration }, duration };
    }),
  },
  guards: {
    hasRecording: ({ context }) => context.recording !== null,
    canPlay: ({ context }) =>
      context.recording !== null && (context.recording.frames?.length ?? 0) > 0,
    hasAudio: ({ context }) => hasPlaybackAudio(context),
    hasExternalAudioBlob: ({ event }) =>
      event.type === "START_RECORDING" && event.audioBlob instanceof Blob,
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
    isValidSeekTime: ({ context, event }) => {
      if (event.type !== "SEEK") return false;
      return event.time >= 0 && event.time <= context.timeline.duration;
    },
  },
  actions: {
    // Recording (capture-side) actions — bodies live in captureActions.ts, wrapped
    // here so `setup()` can infer this machine's exact context/event/actor types.
    setCameraRecordingEnabled: assign(setCameraRecordingEnabled),
    prepareExternalAudioRecording: assign(prepareExternalAudioRecording),
    startExternalAudioPlayback: enqueueActions(startExternalAudioPlayback),
    storeExternalAudioDuration: assign(storeExternalAudioDuration),
    stopExternalAudioRecording: assign(stopExternalAudioRecording),
    initRecordingSession: assign(initRecordingSession),
    captureInitialFrame: assign(captureInitialFrame),
    captureFrame: assign(captureFrame),
    capturePreviewRefreshFrame: assign(capturePreviewRefreshFrame),
    finalizeRecording: assign(finalizeRecording),
    notifyRecordingStart,
    notifyRecordingStop,
    storeAudioBlob: assign(storeAudioBlob),
    storeAudioStarted: assign(storeAudioStarted),
    storeCameraBlob: assign(storeCameraBlob),
    captureAudioChunk: assign(captureAudioChunk),
    storeCameraStarted: assign(storeCameraStarted),
    handleCameraError: assign(handleCameraError),

    // Playback (replay-side) actions — bodies live in replayActions.ts, wrapped
    // here so `setup()` can infer this machine's exact context/event/actor types.
    setRecording: assign(setRecording),
    extendRecording: assign(extendRecording),
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
      actions: assign(({ context, event }) => {
        if (event.type !== "ADD_CAPTION_TRACK" || !context.recording) return {};
        const existing = context.recording.captions ?? [];
        const filtered = existing.filter((t) => t.id !== event.track.id);
        return {
          recording: {
            ...context.recording,
            captions: [...filtered, event.track],
          },
        };
      }),
    },
    REMOVE_CAPTION_TRACK: {
      actions: assign(({ context, event }) => {
        if (event.type !== "REMOVE_CAPTION_TRACK" || !context.recording?.captions) return {};
        const filtered = context.recording.captions.filter((t) => t.id !== event.trackId);
        return {
          recording: {
            ...context.recording,
            captions: filtered.length > 0 ? filtered : undefined,
          },
        };
      }),
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
            actions: "setCameraRecordingEnabled",
          },
          {
            target: "recording",
            actions: [
              "setCameraRecordingEnabled",
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
            assign({
              error: ({ event }) =>
                event.type === "ERROR" ? event.error : "Failed to start audio",
              audio: ({ context }) => ({
                ...context.audio,
                isRecording: false,
                mediaRecorder: null,
                source: null,
                startOffsetMs: 0,
              }),
            }),
            "notifyError",
          ],
        },
        STOP_RECORDING: {
          target: "idle",
          actions: [
            stopChild("audioRecorder"),
            assign({
              audio: ({ context }) => ({
                ...context.audio,
                isRecording: false,
                source: null,
                startOffsetMs: 0,
              }),
            }),
          ],
        },
      },
    },

    recording: {
      entry: [
        spawnChild("mouseTracking", {
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
        }),
        enqueueActions(({ context, enqueue }) => {
          if (!context.enableCameraRecording) return;

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
      ],
      exit: [stopChild("mouseTracker"), stopChild("recordingAudioPlayer")],
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
          actions: [
            assign(({ context, event }) => {
              if (!context.session) return {};

              appendSlideRecordingEvent(context.session, event.event);
              return {
                session: context.session,
                sessionRevision: context.sessionRevision + 1,
              };
            }),
            "captureFrame",
            "notifyFrame",
          ],
        },
        PREVIEW_EVENT: {
          actions: [
            assign(({ context, event }) => {
              if (!context.session) return {};

              appendPreviewRecordingEvent(context.session, event.event);
              return {
                session: context.session,
                sessionRevision: context.sessionRevision + 1,
              };
            }),
            "capturePreviewRefreshFrame",
            "notifyFrame",
          ],
        },
        PREVIEW_INITIAL_DOCUMENT: {
          actions: assign(({ context, event }) => {
            if (!context.session) return {};

            appendPreviewInitialDocument(context.session, event.document);
            return {
              session: context.session,
              sessionRevision: context.sessionRevision + 1,
            };
          }),
        },
        PREVIEW_PATCH_BATCH: {
          actions: assign(({ context, event }) => {
            if (!context.session) return {};

            appendPreviewPatchBatch(context.session, event.batch);
            return {
              session: context.session,
              sessionRevision: context.sessionRevision + 1,
            };
          }),
        },
        WORKSPACE_EVENT: {
          actions: [
            assign(({ context, event }) => {
              const snapshot = context.getWorkspaceSnapshot?.();
              if (!context.session || !snapshot) return {};

              const appended = appendWorkspaceRecordingEvent(context.session, snapshot, {
                sidebarWidthDelta: event.sidebarWidthDelta,
                previewDockWidthDelta: event.previewDockWidthDelta,
              });

              if (!appended) {
                return {};
              }

              return {
                session: context.session,
                sessionRevision: context.sessionRevision + 1,
              };
            }),
          ],
        },
        RUNTIME_EVENT: {
          actions: [
            assign(({ context }) => {
              const snapshot = context.getRuntimeSnapshot?.();
              if (!context.session || !snapshot) return {};

              const appended = appendRuntimeRecordingEvent(context.session, snapshot);

              if (!appended) {
                return {};
              }

              return {
                session: context.session,
                sessionRevision: context.sessionRevision + 1,
              };
            }),
          ],
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
      entry: [
        ...APPLY_REPLAY_STATE_ACTIONS,
        enqueueActions(({ context, enqueue }) => {
          enqueue.spawnChild("timeline", {
            id: "timelineActor",
            input: {
              speed: context.timeline.speed,
              duration: context.timeline.duration,
              startPosition: context.timeline.currentTime,
            },
          });

          syncPlaybackAudio(context, enqueue, {
            spawnIfMissing: true,
            appendPolicy: "never",
            seek: false,
            syncRate: false,
            syncVolume: false,
            play: false,
          });
        }),
      ],
      exit: [
        stopChild("timelineActor"),
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
            enqueueActions(({ context, event, enqueue, self }) => {
              if (event.type !== "EXTEND_RECORDING") {
                return;
              }

              enqueue.sendTo("timelineActor", {
                type: "SET_DURATION",
                duration: Math.max(context.timeline.currentTime, event.recording.duration),
              });

              // Each APPEND_FRAGMENT makes the audio actor decode the *entire*
              // accumulated blob again (`decodeAudioData` over a growing buffer).
              // During a progressive URL load that fired every download interval —
              // quadratic decode work that pinned several cores on long recordings.
              // Only pay for it when playback is actually running (audio must keep
              // extending under the playhead) or on the final, complete blob.
              syncPlaybackAudio(context, enqueue, {
                spawnIfMissing: true,
                appendPolicy: "playing-or-finalized",
                seek: true,
                syncRate: true,
                syncVolume: true,
                play: self.getSnapshot().matches({ playback: "playing" }),
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
                appendPolicy: "always",
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
                  context.timeline.currentTime >= context.timeline.duration - 100, // Fuzzy end check
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
