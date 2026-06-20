import { setup, assign, spawnChild, stopChild, enqueueActions, fromPromise } from "xstate";
import type { SlideEvent, PreviewEvent } from "../slides";
import type {
  EditorMachineContext,
  EditorMachineEvent,
  EditorMachineInput,
  RecordingSessionMediaFragment,
} from "./types";
import { createInitialContext } from "./types";
import type { EditorFrame, MouseCursorPosition, Recording } from "../types";
import type { RuntimeRecordingEvent } from "../../../types/runtime";
import {
  areWorkspaceSnapshotsEqual,
  toSidebarWidthDeltaSnapshot,
  type WorkspaceRecordingEvent,
} from "../../../types/workspace";
import {
  reconstructFrameAtIndex,
  applyFrameDelta,
  findFrameIndexAtTime,
  isKeyframe,
} from "../utils/frameDelta";
import { createFrameStreamEncoder, pushFrame } from "../utils/frameStreamEncoder";
import { timelineMachine } from "./timelineMachine";
import { audioRecordingActor, audioPlaybackActor } from "./audioActor";
import { cameraRecordingActor } from "./cameraActor";
import { mouseTrackingActor } from "./mouseTrackingActor";
import { normalizeEditorFrame, normalizeRecordingData } from "../utils/editorState";
import { isValidFrameState } from "../utils/validation";
import { calculateDurationFromFileReader } from "../utils/audioDuration";
import { arePreviewSizesEqual } from "../../../utils/equality";
import {
  getPreviewReplayResult,
  getRuntimeReplayResult,
  getSlideReplayResult,
  getWorkspaceReplayResult,
  isSeekReplayEvent,
  resolveReplayTime,
} from "./replayState";
import {
  appendPreviewInitialDocument,
  appendPreviewPatchBatch,
  appendPreviewRecordingEvent,
  appendRuntimeRecordingEvent,
  appendSlideRecordingEvent,
  appendWorkspaceRecordingEvent,
} from "./recordingSession";
import {
  APPLY_REPLAY_AFTER_EDITOR_SYNC_ACTIONS,
  APPLY_REPLAY_STATE_ACTIONS,
  APPLY_REPLAY_STATE_AND_STORE_PAUSE_ACTIONS,
  appendCursorEvent,
  applyFrameState,
  AUDIO_TRACK_ID,
  buildMediaFragmentMetadata,
  buildRecordingClusters,
  buildTrackMetadata,
  CAMERA_TRACK_ID,
  createFrame,
  getLoadedRecordingPayload,
  getPlaybackAudioState,
  hasPlaybackAudio,
  hasSpawnedPlaybackAudio,
  MOUSE_FRAME_INTERVAL_MS,
  RESET_AND_REATTACH_REPLAY_STATE_ACTIONS,
  SET_EDITOR_REF_ACTIONS,
  shouldRecordCamera,
  SYNC_PAUSED_WORKSPACE_ACTIONS,
} from "./editorMachineHelpers";

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
    // Recording actions
    setCameraRecordingEnabled: assign(({ context, event }) => {
      if (event.type !== "START_RECORDING") return {};
      return {
        enableCameraRecording: event.enableCamera ?? context.enableCameraRecording,
      };
    }),

    prepareExternalAudioRecording: assign(({ context, event }) => {
      if (event.type !== "START_RECORDING" || !(event.audioBlob instanceof Blob)) {
        return {};
      }

      return {
        audio: {
          ...context.audio,
          blob: event.audioBlob,
          element: null,
          isRecording: true,
          mediaRecorder: null,
          chunks: [],
          mimeType: event.audioBlob.type,
          source: "external" as const,
          externalDurationMs: null,
        },
      };
    }),

    startExternalAudioPlayback: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "START_RECORDING" || !(event.audioBlob instanceof Blob)) {
        return;
      }

      enqueue.spawnChild("audioPlayback", {
        id: "recordingAudioPlayer",
        input: {
          blob: event.audioBlob,
          volume: context.timeline.volume,
          playbackRate: 1,
          startPositionMs: 0,
        },
      });
      enqueue.sendTo("recordingAudioPlayer", { type: "PLAY" });
    }),

    storeExternalAudioDuration: assign(({ context, event }) => {
      if (event.type !== "READY" || context.audio.source !== "external") {
        return {};
      }

      const externalDurationMs = Number.isFinite(event.duration) ? event.duration : null;

      const session =
        context.session && externalDurationMs !== null && context.session.audioFragments.length > 0
          ? {
              ...context.session,
              audioFragments: context.session.audioFragments.map((fragment, index) =>
                index === 0
                  ? {
                      ...fragment,
                      endTimeMs: context.audio.startOffsetMs + externalDurationMs,
                    }
                  : fragment,
              ),
            }
          : context.session;

      return {
        session,
        audio: {
          ...context.audio,
          externalDurationMs,
        },
      };
    }),

    stopExternalAudioRecording: assign(({ context }) => {
      if (context.audio.source !== "external") return {};
      return {
        audio: {
          ...context.audio,
          isRecording: false,
        },
      };
    }),

    initRecordingSession: assign(({ context, event }) => {
      const startedAt =
        event.type === "STARTED" && Number.isFinite(event.startedAtMs)
          ? event.startedAtMs
          : Date.now();
      const slideEvents: SlideEvent[] = [];
      const previewEvents: PreviewEvent[] = [];
      const workspaceEvents: WorkspaceRecordingEvent[] = [];
      const runtimeEvents: RuntimeRecordingEvent[] = [];
      const initialMousePosition: MouseCursorPosition = { x: 0, y: 0, visible: false };
      const externalAudioFragment =
        context.audio.source === "external" && context.audio.blob
          ? [
              {
                trackId: AUDIO_TRACK_ID,
                startTimeMs: context.audio.startOffsetMs,
                endTimeMs:
                  typeof context.audio.externalDurationMs === "number" &&
                  Number.isFinite(context.audio.externalDurationMs)
                    ? context.audio.startOffsetMs + context.audio.externalDurationMs
                    : context.audio.startOffsetMs,
                blob: context.audio.blob,
                mimeType: context.audio.mimeType || context.audio.blob.type || "audio/webm",
              },
            ]
          : [];

      // Capture initial slide state if open
      const initialSlideState = context.getSlideState?.();
      if (initialSlideState?.previewState?.isOpen) {
        slideEvents.push({
          type: "slide_open",
          timestamp: 0,
          slideId: initialSlideState.previewState.currentSlideId || undefined,
          isMaximized: initialSlideState.previewState.isMaximized,
          indexv: initialSlideState.previewState.indexv,
        });
      }

      // Capture initial preview state
      const initialPreviewState = context.getPreviewState?.();
      if (initialPreviewState) {
        previewEvents.push({
          type: "preview_open",
          timestamp: 0,
          size: initialPreviewState.size,
          isOpen: initialPreviewState.isOpen,
          mode: initialPreviewState.mode,
          content: initialPreviewState.content,
          route: initialPreviewState.route,
          scrollTop: initialPreviewState.scrollTop,
          scrollLeft: initialPreviewState.scrollLeft,
        });
      }

      const initialWorkspaceSnapshot = context.getWorkspaceSnapshot?.();
      if (initialWorkspaceSnapshot) {
        workspaceEvents.push({
          timestamp: 0,
          snapshot: toSidebarWidthDeltaSnapshot(initialWorkspaceSnapshot, 0),
        });
      }

      const initialRuntimeSnapshot = context.getRuntimeSnapshot?.();
      if (initialRuntimeSnapshot) {
        runtimeEvents.push({
          timestamp: 0,
          snapshot: initialRuntimeSnapshot,
        });
      }

      return {
        session: {
          startedAt,
          frames: [],
          encoder: createFrameStreamEncoder(),
          slideEvents,
          previewEvents,
          previewInitialDocuments: [],
          previewPatchBatches: [],
          workspaceEvents,
          runtimeEvents,
          cursorEvents: [{ timestamp: 0, ...initialMousePosition }],
          // External (selected file) audio is fully known at start, so seed it as the single
          // audio fragment. Microphone and camera fragments are appended as timeslice events.
          audioFragments: externalAudioFragment,
          cameraFragments: [],
          lastMousePosition: initialMousePosition,
        },
        lastCallbackFrameTimestamp: undefined,
      };
    }),

    captureInitialFrame: assign(({ context }) => {
      const session = context.session;
      if (!session) return {};

      const lastMousePosition = session.lastMousePosition || {
        x: 0,
        y: 0,
        visible: false,
      };

      // Use createFrame for the initial frame to ensure it has all metadata
      const editor = context.editorRefs.editor;
      let initialFrame: EditorFrame;

      if (editor) {
        initialFrame = createFrame(
          editor,
          0,
          lastMousePosition,
          context.getSlideState,
          context.getPreviewState,
        );
      } else {
        initialFrame = {
          timestamp: 0,
          state: {
            content: "",
            selection: {
              startLineNumber: 1,
              startColumn: 1,
              endLineNumber: 1,
              endColumn: 1,
              selectionStartLineNumber: 1,
              selectionStartColumn: 1,
              positionLineNumber: 1,
              positionColumn: 1,
            },
            position: { lineNumber: 1, column: 1 },
            viewState: null,
            mouseCursor: lastMousePosition,
          },
        };
      }

      const { state: encoder, emitted } = pushFrame(session.encoder, initialFrame);

      return {
        session: {
          ...session,
          frames: emitted ? [emitted] : [],
          encoder,
        },
        currentFrame: initialFrame,
      };
    }),

    captureFrame: assign(({ context, event }) => {
      const editor = context.editorRefs.editor;
      if (!editor || !context.session) return {};

      const timestamp = Date.now() - context.session.startedAt;

      const mousePosition =
        event.type === "CAPTURE_FRAME" && event.mousePosition
          ? event.mousePosition
          : context.session.lastMousePosition;
      const cursorEvents =
        event.type === "CAPTURE_FRAME" && event.isMouseMovement
          ? appendCursorEvent(context.session.cursorEvents ?? [], timestamp, mousePosition)
          : context.session.cursorEvents;

      if (event.type === "CAPTURE_FRAME" && event.isMouseMovement) {
        const lastFrame = context.session.encoder.lastFullFrame;
        const lastMousePosition = context.session.lastMousePosition;
        const visibilityChanged = lastMousePosition?.visible !== mousePosition?.visible;

        if (
          lastFrame &&
          timestamp - lastFrame.timestamp < MOUSE_FRAME_INTERVAL_MS &&
          !visibilityChanged
        ) {
          return {
            session: {
              ...context.session,
              cursorEvents,
              lastMousePosition: mousePosition,
            },
          };
        }
      }

      const frame = createFrame(
        editor,
        timestamp,
        mousePosition,
        context.getSlideState,
        context.getPreviewState,
      );

      const { state: encoder, emitted } = pushFrame(context.session.encoder, frame);

      return {
        session: {
          ...context.session,
          frames: emitted ? [...context.session.frames, emitted] : context.session.frames,
          encoder,
          cursorEvents,
          lastMousePosition: mousePosition,
        },
        currentFrame: frame,
      };
    }),

    capturePreviewRefreshFrame: assign(({ context, event }) => {
      if (event.type !== "PREVIEW_EVENT" || event.event.type !== "preview_refresh") {
        return {};
      }

      const editor = context.editorRefs.editor;
      if (!editor || !context.session) {
        return {};
      }

      const timestamp = Date.now() - context.session.startedAt;
      const frame = createFrame(
        editor,
        timestamp,
        context.session.lastMousePosition,
        context.getSlideState,
        context.getPreviewState,
      );

      if (frame.state.previewState) {
        frame.state.previewState = {
          ...frame.state.previewState,
          content: event.event.content ?? frame.state.previewState.content,
        };
      }

      const { state: encoder, emitted } = pushFrame(context.session.encoder, frame);

      return {
        session: {
          ...context.session,
          frames: emitted ? [...context.session.frames, emitted] : context.session.frames,
          encoder,
        },
        currentFrame: frame,
      };
    }),

    finalizeRecording: assign(({ context, event }) => {
      if (!context.session) return { recording: null };

      // Base duration from session timing
      const duration =
        event.type === "FINISHED" &&
        context.audio.source === "external" &&
        typeof context.audio.externalDurationMs === "number" &&
        Number.isFinite(context.audio.externalDurationMs)
          ? Math.max(context.audio.externalDurationMs, 1)
          : Math.max(Date.now() - context.session.startedAt, 1);
      const slides = context.getSlides?.();
      const currentWorkspaceSnapshot = context.getWorkspaceSnapshot?.() || undefined;
      const workspaceSnapshot = currentWorkspaceSnapshot
        ? toSidebarWidthDeltaSnapshot(currentWorkspaceSnapshot, 0)
        : undefined;
      const runtimeSnapshot = context.getRuntimeSnapshot?.() || undefined;

      // Frames were compressed incrementally during capture.
      const frames = context.session.frames;
      const clusters = buildRecordingClusters(frames, duration);
      const tracks = buildTrackMetadata({
        durationMs: duration,
        hasSlideEvents: context.session.slideEvents.length > 0,
        hasPreviewEvents:
          context.session.previewEvents.length > 0 ||
          context.session.previewInitialDocuments.length > 0 ||
          context.session.previewPatchBatches.length > 0,
        hasWorkspaceEvents: context.session.workspaceEvents.length > 0,
        hasRuntimeEvents: context.session.runtimeEvents.length > 0,
        hasCursorEvents: context.session.cursorEvents.length > 0,
        audioMimeType: context.audio.mimeType || context.audio.blob?.type,
        audioSource: context.audio.source || undefined,
        audioStartOffsetMs: context.audio.startOffsetMs,
        hasAudio: context.session.audioFragments.length > 0 || Boolean(context.audio.blob),
        cameraMimeType: context.camera.mimeType || context.camera.blob?.type,
        cameraSource: context.camera.source || undefined,
        cameraStartOffsetMs: context.camera.startOffsetMs,
        hasCamera: context.session.cameraFragments.length > 0 || Boolean(context.camera.blob),
      });
      const mediaFragments = [
        ...buildMediaFragmentMetadata(
          context.session.audioFragments,
          clusters,
          context.audio.source === "external" ? duration : undefined,
        ),
        ...buildMediaFragmentMetadata(context.session.cameraFragments, clusters),
      ];

      const recording: Recording = {
        version: 3,
        id: Date.now().toString(),
        name: `Recording ${Date.now()}`,
        createdAt: Date.now(),
        frames,
        keyframeInterval: 120,
        slideEvents: context.session.slideEvents,
        previewEvents: context.session.previewEvents,
        previewInitialDocuments: context.session.previewInitialDocuments,
        previewPatchBatches: context.session.previewPatchBatches,
        workspaceEvents: context.session.workspaceEvents,
        runtimeEvents: context.session.runtimeEvents,
        cursorEvents: context.session.cursorEvents,
        slides: slides,
        tracks,
        clusters: clusters.length > 0 ? clusters : undefined,
        mediaFragments: mediaFragments.length > 0 ? mediaFragments : undefined,
        duration,
        audioBlob: context.audio.blob || undefined,
        audioSource: context.audio.source || undefined,
        audioStartOffsetMs: context.audio.blob ? context.audio.startOffsetMs : undefined,
        cameraBlob: context.camera.blob || undefined,
        cameraSource: context.camera.source || undefined,
        cameraStartOffsetMs: context.camera.blob ? context.camera.startOffsetMs : undefined,
        streamFinalized: true,
        workspaceSnapshot,
        runtimeSnapshot,
      };

      return {
        recording,
        session: null,
        audio: {
          ...context.audio,
          isRecording: false,
          mediaRecorder: null,
          source: null,
          startOffsetMs: 0,
          externalDurationMs: null,
        },
        camera: {
          blob: null,
          isRecording: false,
          mimeType: "",
          source: null,
          startOffsetMs: 0,
        },
        timeline: {
          ...context.timeline,
          duration,
        },
        lastAppliedFrameIndex: -1,
        lastAppliedPreviewEventIndex: -1,
        lastAppliedPreviewPatchBatchIndex: -1,
        lastAppliedSlideEventIndex: -1,
        lastAppliedWorkspaceEventIndex: -1,
        lastAppliedRuntimeEventIndex: -1,
      };
    }),

    // Playback actions
    setRecording: assign(({ context, event }) => {
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

      return {
        recording,
        hasManualWorkspaceOverride: false,
        pendingPlaybackEditorSync: false,
        playbackAudioSpawned: false,
        timeline: {
          currentTime: 0,
          duration,
          speed: 1,
          volume: 1,
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
        lastAppliedPreviewState: undefined,
      };
    }),

    // Streaming playback: replace the loaded recording with a longer prefix of the same SCR3
    // stream. Because the stream is append-only, the new recording is a superset of the current
    // one, so the already-applied playback indices, current time, and timeline stay valid — we
    // only swap in the larger frames/events arrays and let the replay cursors catch up.
    extendRecording: assign(({ context, event }) => {
      if (event.type !== "EXTEND_RECORDING" || !context.recording) return {};
      const recording = normalizeRecordingData(event.recording);
      return {
        recording,
        timeline: {
          ...context.timeline,
          duration: Math.max(context.timeline.currentTime, recording.duration),
        },
      };
    }),

    applyFrameAtTime: assign(({ context, event }) => {
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
        frame = applyFrameDelta(currentFrame, targetFrame);
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

      if (
        frame.state.previewState &&
        context.applyPreviewState &&
        !recording.previewEvents?.length
      ) {
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
    }),

    seekToTime: assign(({ context, event }) => {
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
        lastAppliedWorkspaceEventIndex: -1,
        lastAppliedRuntimeEventIndex: -1,
      };
    }),

    setPlaybackSpeed: assign(({ context, event }) => {
      if (event.type !== "SET_SPEED") return {};
      return {
        timeline: {
          ...context.timeline,
          speed: event.speed,
        },
      };
    }),

    setVolume: assign(({ context, event }) => {
      if (event.type !== "SET_VOLUME") return {};
      return {
        timeline: {
          ...context.timeline,
          volume: Math.max(0, Math.min(1, event.volume)),
        },
      };
    }),

    clearCursorDecorations: assign(({ context }) => {
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
    }),

    storeRecordedFrameAtPause: assign(({ context }) => {
      return {
        recordedFrameAtPause: context.currentFrame,
      };
    }),

    adoptPlaybackWorkspaceAtPause: ({ context }) => {
      const currentSnapshot = context.getWorkspaceSnapshot?.();
      const activeFilePath = currentSnapshot?.activeFilePath;
      const currentFile = activeFilePath
        ? currentSnapshot?.project.files[activeFilePath]
        : undefined;
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
    },

    restoreRecordedFrameFromPause: ({ context }) => {
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
    },

    resetPlayback: assign(({ context }) => ({
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
      lastAppliedWorkspaceEventIndex: -1,
      lastAppliedRuntimeEventIndex: -1,
      lastAppliedPreviewState: undefined,
    })),

    invalidateAppliedPlaybackState: assign(() => ({
      currentFrame: null,
      lastCallbackFrameTimestamp: undefined,
      lastAppliedFrameIndex: -1,
      lastAppliedPreviewEventIndex: -1,
      lastAppliedPreviewPatchBatchIndex: -1,
      lastAppliedSlideEventIndex: -1,
      lastAppliedWorkspaceEventIndex: -1,
      lastAppliedRuntimeEventIndex: -1,
      lastAppliedPreviewState: undefined,
    })),

    detachPlaybackWorkspace: assign(() => ({
      hasManualWorkspaceOverride: true,
      pendingPlaybackEditorSync: false,
      currentFrame: null,
      lastAppliedFrameIndex: -1,
      lastAppliedPreviewEventIndex: -1,
      lastAppliedPreviewPatchBatchIndex: -1,
      lastAppliedSlideEventIndex: -1,
      lastAppliedWorkspaceEventIndex: -1,
      lastAppliedRuntimeEventIndex: -1,
      lastAppliedPreviewState: undefined,
    })),

    reattachPlaybackWorkspace: assign(({ context }) => ({
      hasManualWorkspaceOverride: false,
      pendingPlaybackEditorSync: context.hasManualWorkspaceOverride,
    })),

    clearPendingPlaybackEditorSync: assign(() => ({
      pendingPlaybackEditorSync: false,
    })),

    // Editor/model swaps only invalidate Monaco-rendered frame state. Keep the
    // dedicated preview/slide replay cursors stable so file switches do not
    // replay their full history.
    invalidateRenderedPlaybackState: assign(() => ({
      currentFrame: null,
      lastAppliedFrameIndex: -1,
    })),

    clearRecording: assign({
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
      lastAppliedPreviewState: undefined,
      timeline: ({ context }) => ({
        ...context.timeline,
        currentTime: 0,
        duration: 0,
      }),
    }),

    setError: assign(({ event }) => {
      if (event.type !== "LOAD_FAILED") return {};
      return { error: event.error };
    }),

    clearError: assign({ error: null }),

    notifyRecordingStart: ({ context }) => {
      context.onRecordingStart?.();
    },

    notifyRecordingStop: ({ context }) => {
      if (context.recording) {
        context.onRecordingStop?.(context.recording);
      }
    },

    notifyPlaybackStart: ({ context }) => {
      context.onPlaybackStart?.();
    },

    notifyPlaybackPause: ({ context }) => {
      context.onPlaybackPause?.();
    },

    notifyPlaybackEnd: ({ context }) => {
      context.onPlaybackEnd?.();
    },

    notifySeek: ({ context, event }) => {
      if (event.type === "SEEK") {
        context.onSeek?.(event.time);
      }
    },

    notifyError: ({ context }) => {
      if (context.error) {
        context.onError?.(new Error(context.error));
      }
    },

    notifyFrame: assign(({ context }) => {
      const frame = context.currentFrame;
      if (!frame || context.lastCallbackFrameTimestamp === frame.timestamp) {
        return {};
      }

      context.onFrame?.(frame);
      context.onStateChange?.(frame.state);

      return {
        lastCallbackFrameTimestamp: frame.timestamp,
      };
    }),

    notifyPlaybackUpdate: ({ context }) => {
      context.onPlaybackUpdate?.(context.timeline.currentTime, context.currentFrame);
    },

    storeAudioBlob: assign(({ event }) => {
      if (event.type !== "STOPPED") return {};
      return {
        audio: {
          blob: event.blob,
          element: null,
          isRecording: false,
          mediaRecorder: null,
          chunks: [],
          mimeType: event.blob.type,
          source: "microphone" as const,
          startOffsetMs: 0,
          externalDurationMs: null,
        },
      };
    }),

    storeAudioStarted: assign(({ context, event }) => {
      if (event.type !== "STARTED") return {};
      return {
        audio: {
          ...context.audio,
          mediaRecorder: event.mediaRecorder,
          mimeType: event.mimeType,
          startOffsetMs: 0,
        },
      };
    }),

    storeCameraBlob: assign(({ context, event }) => {
      if (event.type !== "CAMERA_STOPPED") return {};
      return {
        camera: {
          ...context.camera,
          blob: event.blob,
          isRecording: false,
          mimeType: event.blob.type,
          source: "camera" as const,
        },
      };
    }),

    // Append a live microphone timeslice fragment to the session's append-only audio stream so
    // an optional live recording sink can forward it. The finalized blob (STOPPED) is unchanged.
    captureAudioChunk: assign(({ context, event }) => {
      if (event.type !== "CHUNK" || !context.session) return {};
      const fragment: RecordingSessionMediaFragment = {
        trackId: AUDIO_TRACK_ID,
        startTimeMs: context.audio.startOffsetMs + event.startTimeMs,
        endTimeMs: context.audio.startOffsetMs + event.endTimeMs,
        blob: event.chunk,
        mimeType: event.chunk.type || context.audio.mimeType || "audio/webm",
      };
      return {
        session: {
          ...context.session,
          audioFragments: [...context.session.audioFragments, fragment],
        },
      };
    }),

    captureCameraChunk: assign(({ context, event }) => {
      if (event.type !== "CAMERA_CHUNK" || !context.session) return {};
      const fragment: RecordingSessionMediaFragment = {
        trackId: CAMERA_TRACK_ID,
        startTimeMs: context.camera.startOffsetMs + event.startTimeMs,
        endTimeMs: context.camera.startOffsetMs + event.endTimeMs,
        blob: event.chunk,
        mimeType: event.chunk.type || context.camera.mimeType || "video/webm",
      };
      return {
        session: {
          ...context.session,
          cameraFragments: [...context.session.cameraFragments, fragment],
        },
      };
    }),

    storeCameraStarted: assign(({ context, event }) => {
      if (event.type !== "CAMERA_STARTED") return {};
      // The camera MediaRecorder only starts after getUserMedia resolves, which lags the
      // recording-session origin (session.startedAt) by the camera warmup. Capture that offset so
      // playback can shift the video back into sync; otherwise the face video runs ahead of audio.
      const startOffsetMs = context.session
        ? Math.max(0, event.startedAtMs - context.session.startedAt)
        : 0;
      return {
        camera: {
          ...context.camera,
          mimeType: event.mimeType,
          startOffsetMs,
        },
      };
    }),

    handleCameraError: assign(({ context, event }) => {
      if (event.type !== "CAMERA_ERROR") return {};
      console.warn("Camera recording disabled:", event.error);
      return {
        camera: {
          ...context.camera,
          isRecording: false,
          mimeType: "",
          source: null,
          startOffsetMs: 0,
        },
      };
    }),

    setEditorRef: assign(({ context, event }) => {
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
    }),

    applyPreviewEventsAtTime: assign(({ context, event }) => {
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
    }),
    applyPreviewPatchBatchesAtTime: assign(({ context, event }) => {
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
    }),
    applyWorkspaceEventsAtTime: assign(({ context, event }) => {
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
    }),
    applyRuntimeEventsAtTime: assign(({ context, event }) => {
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
    }),
    applySlideEventsAtTime: assign(({ context, event }) => {
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
    }),
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
        CAMERA_CHUNK: {
          actions: "captureCameraChunk",
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
            }),
            "notifyError",
          ],
        },
        SLIDE_EVENT: {
          actions: [
            assign(({ context, event }) => {
              if (!context.session) return {};

              return {
                session: appendSlideRecordingEvent(context.session, event.event),
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

              return {
                session: appendPreviewRecordingEvent(context.session, event.event),
              };
            }),
            "capturePreviewRefreshFrame",
            "notifyFrame",
          ],
        },
        PREVIEW_INITIAL_DOCUMENT: {
          actions: assign(({ context, event }) => {
            if (!context.session) return {};

            return {
              session: appendPreviewInitialDocument(context.session, event.document),
            };
          }),
        },
        PREVIEW_PATCH_BATCH: {
          actions: assign(({ context, event }) => {
            if (!context.session) return {};

            return {
              session: appendPreviewPatchBatch(context.session, event.batch),
            };
          }),
        },
        WORKSPACE_EVENT: {
          actions: [
            assign(({ context, event }) => {
              const snapshot = context.getWorkspaceSnapshot?.();
              if (!context.session || !snapshot) return {};

              const nextSession = appendWorkspaceRecordingEvent(
                context.session,
                snapshot,
                event.sidebarWidthDelta,
              );

              if (nextSession === context.session) {
                return {};
              }

              return {
                session: nextSession,
              };
            }),
          ],
        },
        RUNTIME_EVENT: {
          actions: [
            assign(({ context }) => {
              const snapshot = context.getRuntimeSnapshot?.();
              if (!context.session || !snapshot) return {};

              const nextSession = appendRuntimeRecordingEvent(context.session, snapshot);

              if (nextSession === context.session) {
                return {};
              }

              return {
                session: nextSession,
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
        CAMERA_CHUNK: {
          actions: "captureCameraChunk",
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

          const audioState = getPlaybackAudioState(context.recording);
          if (audioState) {
            enqueue.spawnChild("audioPlayback", {
              id: "audioPlayer",
              input: {
                blob: audioState.blob,
                mode: audioState.streamMode ? "stream" : "blob",
                loadedUntilMs: audioState.loadedUntilMs,
                startOffsetMs: audioState.startOffsetMs,
                finalized: audioState.finalized,
                volume: context.timeline.volume,
                playbackRate: context.timeline.speed,
                startPositionMs: context.timeline.currentTime,
              },
            });
            enqueue.assign({ playbackAudioSpawned: true });
          }
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

              const audioState = getPlaybackAudioState(event.recording);
              if (!audioState) {
                return;
              }

              if (!context.playbackAudioSpawned) {
                enqueue.spawnChild("audioPlayback", {
                  id: "audioPlayer",
                  input: {
                    blob: audioState.blob,
                    mode: audioState.streamMode ? "stream" : "blob",
                    loadedUntilMs: audioState.loadedUntilMs,
                    startOffsetMs: audioState.startOffsetMs,
                    finalized: audioState.finalized,
                    volume: context.timeline.volume,
                    playbackRate: context.timeline.speed,
                    startPositionMs: context.timeline.currentTime,
                  },
                });
                enqueue.assign({ playbackAudioSpawned: true });
              } else {
                enqueue.sendTo("audioPlayer", {
                  type: "APPEND_FRAGMENT",
                  blob: audioState.blob,
                  loadedUntilMs: audioState.loadedUntilMs,
                  finalized: audioState.finalized,
                });
                if (audioState.finalized) {
                  enqueue.sendTo("audioPlayer", { type: "FINALIZE_STREAM" });
                }
              }

              enqueue.sendTo("audioPlayer", {
                type: "SEEK",
                timeMs: context.timeline.currentTime,
              });
              enqueue.sendTo("audioPlayer", {
                type: "SET_PLAYBACK_RATE",
                rate: context.timeline.speed,
              });
              enqueue.sendTo("audioPlayer", {
                type: "SET_VOLUME",
                volume: context.timeline.volume,
              });

              if (self.getSnapshot().matches({ playback: "playing" })) {
                enqueue.sendTo("audioPlayer", { type: "PLAY" });
              }
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
              // audio first can briefly play stale audio at high speeds.
              const audioState = getPlaybackAudioState(context.recording);
              const shouldSpawnPlaybackAudio = Boolean(audioState) && !context.playbackAudioSpawned;
              const shouldControlPlaybackAudio =
                context.playbackAudioSpawned || Boolean(audioState);

              // Streaming playback: the audio may have arrived after the recording was first
              // loaded (its bytes are at the end of the stream), so the playback-entry spawn
              // saw no audio. Spawn the player lazily now that audio is available.
              if (shouldSpawnPlaybackAudio && audioState) {
                enqueue.spawnChild("audioPlayback", {
                  id: "audioPlayer",
                  input: {
                    blob: audioState.blob,
                    mode: audioState.streamMode ? "stream" : "blob",
                    loadedUntilMs: audioState.loadedUntilMs,
                    startOffsetMs: audioState.startOffsetMs,
                    finalized: audioState.finalized,
                    volume: context.timeline.volume,
                    playbackRate: context.timeline.speed,
                    startPositionMs: context.timeline.currentTime,
                  },
                });
                enqueue.assign({ playbackAudioSpawned: true });
              } else if (shouldControlPlaybackAudio && audioState) {
                enqueue.sendTo("audioPlayer", {
                  type: "APPEND_FRAGMENT",
                  blob: audioState.blob,
                  loadedUntilMs: audioState.loadedUntilMs,
                  finalized: audioState.finalized,
                });
                if (audioState.finalized) {
                  enqueue.sendTo("audioPlayer", { type: "FINALIZE_STREAM" });
                }
              }

              enqueue.sendTo("timelineActor", {
                type: "SEEK",
                time: context.timeline.currentTime,
              });
              if (shouldControlPlaybackAudio) {
                enqueue.sendTo("audioPlayer", {
                  type: "SEEK",
                  timeMs: context.timeline.currentTime,
                });
                enqueue.sendTo("audioPlayer", {
                  type: "SET_PLAYBACK_RATE",
                  rate: context.timeline.speed,
                });
              }
              enqueue.sendTo("timelineActor", { type: "START" });
              if (shouldControlPlaybackAudio) {
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
