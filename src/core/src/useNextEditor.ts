import { useEffect } from "react";
import type * as monaco from "monaco-editor";
import { useActorRef, useSelector, shallowEqual } from "@xstate/react";
import type { ActorRefFrom } from "xstate";
import { editorMachine } from "./machine/editorMachine";
import type {
  CaptionTrack,
  UseNextEditorConfig,
  UseNextEditorReturn,
  EditorState,
  EditorFrame,
  Recording,
} from "./types";
import type {
  PreviewDomPatchBatch,
  PreviewEvent,
  PreviewInitialDocument,
  SlideEvent,
} from "./slides";
import { findFrameIndexAtTime, reconstructFrameAtIndex } from "./utils/frameDelta";
import type { TimelineActorRef } from "./machine/timelineMachine";
import type { SnapshotFrom } from "xstate";

// ============================================================================
// Type for machine snapshot
// ============================================================================
export type EditorMachineSnapshot = SnapshotFrom<typeof editorMachine>;
export type EditorActorRef = ActorRefFrom<typeof editorMachine>;

const IGNORED_PLAYBACK_INPUT_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "Escape",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
]);

// ============================================================================
// Selectors - Memoized functions for extracting state slices
// ============================================================================

const getPlaybackState = (state: EditorMachineSnapshot): string | null => {
  const stateValue = state.value;

  if (
    typeof stateValue === "object" &&
    stateValue !== null &&
    "playback" in stateValue &&
    typeof stateValue.playback === "string"
  ) {
    return stateValue.playback;
  }

  return null;
};

// Recording state selectors
export const selectIsRecording = (state: EditorMachineSnapshot) => state.value === "recording";
export const selectIsRecordingAudio = (state: EditorMachineSnapshot) =>
  state.context.audio.isRecording;
export const selectRecordingStartTime = (state: EditorMachineSnapshot) =>
  state.context.session?.startedAt || null;

// Playback state selectors
export const selectIsPlaying = (state: EditorMachineSnapshot) =>
  getPlaybackState(state) === "playing";
export const selectIsPaused = (state: EditorMachineSnapshot) =>
  getPlaybackState(state) === "paused" ||
  (getPlaybackState(state) === "ended" &&
    state.context.timeline.currentTime < state.context.timeline.duration - 100);
export const selectHasEnded = (state: EditorMachineSnapshot) =>
  getPlaybackState(state) === "ended" &&
  state.context.timeline.currentTime >= state.context.timeline.duration - 100;
export const selectUsesPlaybackModel = (state: EditorMachineSnapshot) => {
  const playbackState = getPlaybackState(state);

  return (
    !state.context.hasManualWorkspaceOverride &&
    (playbackState === "playing" || playbackState === "paused" || playbackState === "ended")
  );
};

// Timeline selectors (high-frequency updates)
export const selectPlaybackSpeed = (state: EditorMachineSnapshot) => state.context.timeline.speed;
export const selectVolume = (state: EditorMachineSnapshot) => state.context.timeline.volume;
export const selectDuration = (state: EditorMachineSnapshot) => state.context.timeline.duration;
export const selectLiveTime = (state: EditorMachineSnapshot) => state.context.timeline.currentTime;

// Data selectors
export const selectRecording = (state: EditorMachineSnapshot) => state.context.recording;
export const selectEditor = (state: EditorMachineSnapshot) => state.context.editorRefs.editor;
export const selectTimelineActor = (state: EditorMachineSnapshot) =>
  state.children.timelineActor as TimelineActorRef | undefined;
export const selectLiveCursor = (state: EditorMachineSnapshot) =>
  state.context.currentFrame?.state?.mouseCursor || null;

export const useNextEditorActorBindings = (
  actorRef: EditorActorRef,
  config: UseNextEditorConfig,
): UseNextEditorReturn => {
  // Subscribe to specific state slices using selectors
  // Recording state
  const isRecording = useSelector(actorRef, selectIsRecording);
  const isRecordingAudio = useSelector(actorRef, selectIsRecordingAudio);
  const recordingStartTime = useSelector(actorRef, selectRecordingStartTime);

  // Playback state
  const isPlaying = useSelector(actorRef, selectIsPlaying);
  const isPaused = useSelector(actorRef, selectIsPaused);
  const hasEnded = useSelector(actorRef, selectHasEnded);

  // Timeline state (high-frequency)
  const playbackSpeed = useSelector(actorRef, selectPlaybackSpeed);
  const volume = useSelector(actorRef, selectVolume);
  const duration = useSelector(actorRef, selectDuration);

  // Data - using shallowEqual for object selectors per XState docs
  const currentRecording = useSelector(actorRef, selectRecording, shallowEqual);
  const editor = useSelector(actorRef, selectEditor);
  const timelineActor = useSelector(actorRef, selectTimelineActor);

  // Handle editor ref synchronization - run on every render to catch ref changes
  useEffect(() => {
    const currentEditor = config.editorRef.current;
    if (currentEditor && currentEditor !== editor) {
      actorRef.send({ type: "SET_EDITOR_REF", editor: currentEditor });
    }
  }); // No dependencies - run on every render to catch ref changes

  // Recording Controls
  const startRecording = (options?: { audioBlob?: Blob; enableCamera?: boolean }) => {
    actorRef.send({
      type: "START_RECORDING",
      audioBlob: options?.audioBlob,
      enableCamera: options?.enableCamera,
    });
  };

  const stopRecording = () => {
    actorRef.send({ type: "STOP_RECORDING" });
  };

  // Playback Controls
  const play = () => {
    actorRef.send({ type: "PLAY" });
  };

  const pause = () => {
    actorRef.send({ type: "PAUSE" });
  };

  const stop = () => {
    actorRef.send({ type: "STOP" });
  };

  const seekTo = (time: number) => {
    actorRef.send({ type: "SEEK", time });
  };

  const setPlaybackSpeed = (speed: number) => {
    actorRef.send({ type: "SET_SPEED", speed });
  };

  const setVolume = (vol: number) => {
    actorRef.send({ type: "SET_VOLUME", volume: vol });
  };

  const loadRecording = (recording: Recording) => {
    actorRef.send({ type: "LOAD_RECORDING", recording });
  };

  const extendRecording = (recording: Recording) => {
    actorRef.send({ type: "EXTEND_RECORDING", recording });
  };

  const addCaptionTrack = (track: CaptionTrack) => {
    actorRef.send({ type: "ADD_CAPTION_TRACK", track });
  };

  const removeCaptionTrack = (trackId: string) => {
    actorRef.send({ type: "REMOVE_CAPTION_TRACK", trackId });
  };

  const clearRecording = () => {
    actorRef.send({ type: "UNLOAD" });
  };

  const syncEditorRef = (nextEditor: monaco.editor.IStandaloneCodeEditor | null) => {
    actorRef.send({ type: "SET_EDITOR_REF", editor: nextEditor });
  };

  // Event Handlers for UI
  const handleEditorChange = () => {
    actorRef.send({ type: "CAPTURE_FRAME" });
  };

  // Handle playback interaction detection via direct input listeners
  // This is more stable than onChange for preventing machine/user feedback loops
  useEffect(() => {
    if (isPlaying && editor) {
      const disposables: monaco.IDisposable[] = [];

      // Listen for user keyboard input during replay
      disposables.push(
        editor.onKeyDown((e) => {
          // Ignore navigation/modifier keys to only pause on potential value changes
          if (!IGNORED_PLAYBACK_INPUT_KEYS.has(e.browserEvent.key)) {
            actorRef.send({ type: "USER_INTERACTION" });
          }
        }),
      );

      // Listen for paste events
      disposables.push(
        editor.onDidPaste(() => {
          actorRef.send({ type: "USER_INTERACTION" });
        }),
      );

      return () => {
        disposables.forEach((d) => d.dispose());
      };
    }
  }, [isPlaying, editor, actorRef]);

  // Global space key listener to pause playback
  useEffect(() => {
    if (isPlaying) {
      const handleGlobalKeyDown = (e: KeyboardEvent) => {
        // Only trigger on Space key
        if (e.code === "Space" || e.key === " ") {
          e.preventDefault(); // Prevent page scrolling
          actorRef.send({ type: "USER_INTERACTION" }); // This triggers PAUSE in the machine
        }
      };

      window.addEventListener("keydown", handleGlobalKeyDown, true); // Use capture phase to catch it early
      return () => {
        window.removeEventListener("keydown", handleGlobalKeyDown, true);
      };
    }
  }, [isPlaying, actorRef]);

  const handleSlideEvent = (event: SlideEvent) => {
    actorRef.send({ type: "SLIDE_EVENT", event });
  };

  const handlePreviewEvent = (event: PreviewEvent) => {
    actorRef.send({ type: "PREVIEW_EVENT", event });
  };

  const handlePreviewInitialDocument = (document: PreviewInitialDocument) => {
    actorRef.send({ type: "PREVIEW_INITIAL_DOCUMENT", document });
  };

  const handlePreviewPatchBatch = (batch: PreviewDomPatchBatch) => {
    actorRef.send({ type: "PREVIEW_PATCH_BATCH", batch });
  };

  const handleWorkspaceEvent = (event?: {
    sidebarWidthDelta?: number;
    previewDockWidthDelta?: number;
  }) => {
    actorRef.send({
      type: "WORKSPACE_EVENT",
      sidebarWidthDelta: event?.sidebarWidthDelta,
      previewDockWidthDelta: event?.previewDockWidthDelta,
    });
  };

  const handleRuntimeEvent = () => {
    actorRef.send({ type: "RUNTIME_EVENT" });
  };

  // Helper functions
  const getEditorState = (): EditorState | null => {
    if (!editor) return null;
    return {
      content: editor.getValue(),
      selection: editor.getSelection()!,
      position: editor.getPosition()!,
      viewState: editor.saveViewState(),
    };
  };

  const getFrame = (timestamp?: number): EditorFrame | null => {
    if (!currentRecording) return null;

    if (timestamp === undefined) {
      // Get current frame from actor context directly to avoid hook-level re-renders
      return actorRef.getSnapshot().context.currentFrame;
    }

    // Find closest frame at or before timestamp
    const { frames } = currentRecording;
    const index = findFrameIndexAtTime(frames, timestamp);
    return reconstructFrameAtIndex(frames, index);
  };

  return {
    // State
    isRecording,
    isRecordingAudio,
    recordingStartTime,

    isPlaying,
    isPaused,
    hasEnded,

    timelineActor,
    editorActor: actorRef,
    playbackSpeed,
    volume,

    // Data
    currentRecording,
    actualDuration: duration / 1000, // seconds for actualDuration

    // Controls
    startRecording,
    stopRecording,
    play,
    pause,
    stop,
    seekTo,
    setPlaybackSpeed,
    setVolume,
    loadRecording,
    extendRecording,
    addCaptionTrack,
    removeCaptionTrack,
    clearRecording,

    // Integration
    syncEditorRef,
    handleEditorChange,
    handleSlideEvent,
    handlePreviewEvent,
    handlePreviewInitialDocument,
    handlePreviewPatchBatch,
    handleWorkspaceEvent,
    handleRuntimeEvent,

    // Helpers
    getEditorState,
    getFrame,
  };
};

/**
 * Main useNextEditor hook refactored with XState v5
 * Uses useActorRef + useSelector for optimized re-renders.
 * Components using specific selectors only re-render when those values change.
 */
export const useNextEditor = (config: UseNextEditorConfig): UseNextEditorReturn => {
  // Initialize the actor ref (stable reference, doesn't cause re-renders)
  const actorRef = useActorRef(editorMachine, {
    input: config,
  });

  return useNextEditorActorBindings(actorRef, config);
};
