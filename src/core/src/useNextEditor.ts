import { useCallback, useEffect } from "react";
import * as monaco from "monaco-editor";
import { useActorRef, useSelector, shallowEqual } from "@xstate/react";
import type { ActorRefFrom } from "xstate";
import { editorMachine } from "./machine/editorMachine";
import type {
  UseNextEditorConfig,
  UseNextEditorReturn,
  EditorState,
  EditorFrame,
  Recording,
} from "./types";
import type { SlideEvent, PreviewEvent } from "./slides";
import {
  findFrameIndexAtTime,
  reconstructFrameAtIndex,
} from "./utils/frameDelta";
import type { TimelineActorRef } from "./machine/timelineMachine";
import type { SnapshotFrom } from "xstate";

// ============================================================================
// Type for machine snapshot
// ============================================================================
type EditorMachineSnapshot = SnapshotFrom<typeof editorMachine>;
export type EditorActorRef = ActorRefFrom<typeof editorMachine>;

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
const selectIsRecording = (state: EditorMachineSnapshot) =>
  state.value === "recording";
const selectIsRecordingAudio = (state: EditorMachineSnapshot) =>
  state.context.audio.isRecording;
const selectRecordingStartTime = (state: EditorMachineSnapshot) =>
  state.context.session?.startedAt || null;

// Playback state selectors
const selectIsPlaying = (state: EditorMachineSnapshot) =>
  getPlaybackState(state) === "playing";
const selectIsPaused = (state: EditorMachineSnapshot) =>
  getPlaybackState(state) === "paused" ||
  (getPlaybackState(state) === "ended" &&
    state.context.timeline.currentTime < state.context.timeline.duration - 100);
const selectHasEnded = (state: EditorMachineSnapshot) =>
  getPlaybackState(state) === "ended" &&
  state.context.timeline.currentTime >= state.context.timeline.duration - 100;

// Timeline selectors (high-frequency updates)
const selectPlaybackSpeed = (state: EditorMachineSnapshot) =>
  state.context.timeline.speed;
const selectVolume = (state: EditorMachineSnapshot) =>
  state.context.timeline.volume;
const selectDuration = (state: EditorMachineSnapshot) =>
  state.context.timeline.duration;

// Data selectors
const selectRecording = (state: EditorMachineSnapshot) =>
  state.context.recording;
const selectEditor = (state: EditorMachineSnapshot) =>
  state.context.editorRefs.editor;
const selectTimelineActor = (state: EditorMachineSnapshot) =>
  state.children.timelineActor as TimelineActorRef | undefined;

/**
 * Main useNextEditor hook refactored with XState v5
 * Uses useActorRef + useSelector for optimized re-renders.
 * Components using specific selectors only re-render when those values change.
 */
export const useNextEditor = (
  config: UseNextEditorConfig,
): UseNextEditorReturn => {
  // Initialize the actor ref (stable reference, doesn't cause re-renders)
  const actorRef = useActorRef(editorMachine, {
    input: config,
  });

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
  const startRecording = useCallback(() => {
    actorRef.send({ type: "START_RECORDING" });
  }, [actorRef]);

  const stopRecording = useCallback(() => {
    actorRef.send({ type: "STOP_RECORDING" });
  }, [actorRef]);

  // Playback Controls
  const play = useCallback(() => {
    actorRef.send({ type: "PLAY" });
  }, [actorRef]);

  const pause = useCallback(() => {
    actorRef.send({ type: "PAUSE" });
  }, [actorRef]);

  const stop = useCallback(() => {
    actorRef.send({ type: "STOP" });
  }, [actorRef]);

  const seekTo = useCallback(
    (time: number) => {
      actorRef.send({ type: "SEEK", time });
    },
    [actorRef],
  );

  const setPlaybackSpeed = useCallback(
    (speed: number) => {
      actorRef.send({ type: "SET_SPEED", speed });
    },
    [actorRef],
  );

  const setVolume = useCallback(
    (vol: number) => {
      actorRef.send({ type: "SET_VOLUME", volume: vol });
    },
    [actorRef],
  );

  const loadRecording = useCallback(
    (recording: Recording) => {
      actorRef.send({ type: "LOAD_RECORDING", recording });
    },
    [actorRef],
  );

  const clearRecording = useCallback(() => {
    actorRef.send({ type: "UNLOAD" });
  }, [actorRef]);

  const syncEditorRef = useCallback(
    (nextEditor: monaco.editor.IStandaloneCodeEditor | null) => {
      actorRef.send({ type: "SET_EDITOR_REF", editor: nextEditor });
    },
    [actorRef],
  );

  // Event Handlers for UI
  const handleEditorChange = useCallback(() => {
    actorRef.send({ type: "CAPTURE_FRAME" });
  }, [actorRef]);

  // Handle playback interaction detection via direct input listeners
  // This is more stable than onChange for preventing machine/user feedback loops
  useEffect(() => {
    if (isPlaying && editor) {
      const disposables: monaco.IDisposable[] = [];

      // Listen for user keyboard input during replay
      disposables.push(
        editor.onKeyDown((e) => {
          // Ignore navigation/modifier keys to only pause on potential value changes
          const ignoreKeys = [
            monaco.KeyCode.LeftArrow,
            monaco.KeyCode.RightArrow,
            monaco.KeyCode.UpArrow,
            monaco.KeyCode.DownArrow,
            monaco.KeyCode.PageUp,
            monaco.KeyCode.PageDown,
            monaco.KeyCode.Home,
            monaco.KeyCode.End,
            monaco.KeyCode.Shift,
            monaco.KeyCode.Ctrl,
            monaco.KeyCode.Alt,
            monaco.KeyCode.Meta,
            monaco.KeyCode.CapsLock,
            monaco.KeyCode.Escape,
            monaco.KeyCode.F1,
            monaco.KeyCode.F2,
            monaco.KeyCode.F3,
            monaco.KeyCode.F4,
            monaco.KeyCode.F5,
            monaco.KeyCode.F6,
            monaco.KeyCode.F7,
            monaco.KeyCode.F8,
            monaco.KeyCode.F9,
            monaco.KeyCode.F10,
            monaco.KeyCode.F11,
            monaco.KeyCode.F12,
          ];

          if (!ignoreKeys.includes(e.keyCode)) {
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

  const handleSlideEvent = useCallback(
    (event: SlideEvent) => {
      actorRef.send({ type: "SLIDE_EVENT", event });
    },
    [actorRef],
  );

  const handlePreviewEvent = useCallback(
    (event: PreviewEvent) => {
      actorRef.send({ type: "PREVIEW_EVENT", event });
    },
    [actorRef],
  );

  const handleWorkspaceEvent = useCallback(() => {
    actorRef.send({ type: "WORKSPACE_EVENT" });
  }, [actorRef]);

  const handleRuntimeEvent = useCallback(() => {
    actorRef.send({ type: "RUNTIME_EVENT" });
  }, [actorRef]);

  // Helper functions
  const getEditorState = useCallback((): EditorState | null => {
    if (!editor) return null;
    return {
      content: editor.getValue(),
      selection: editor.getSelection()!,
      position: editor.getPosition()!,
      viewState: editor.saveViewState(),
    };
  }, [editor]);

  const getFrame = useCallback(
    (timestamp?: number): EditorFrame | null => {
      if (!currentRecording) return null;

      if (timestamp === undefined) {
        // Get current frame from actor context directly to avoid hook-level re-renders
        return actorRef.getSnapshot().context.currentFrame;
      }

      // Find closest frame at or before timestamp
      const { frames } = currentRecording;
      const index = findFrameIndexAtTime(frames, timestamp);
      return reconstructFrameAtIndex(frames, index);
    },
    [actorRef, currentRecording],
  );

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
    clearRecording,

    // Integration
    syncEditorRef,
    handleEditorChange,
    handleSlideEvent,
    handlePreviewEvent,
    handleWorkspaceEvent,
    handleRuntimeEvent,

    // Helpers
    getEditorState,
    getFrame,
  };
};
