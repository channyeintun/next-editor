import { useEffect, useState } from "react";
import type * as monaco from "monaco-editor";
import { useSelector } from "@xstate/react";
import type { ActorRefFrom } from "xstate";
import { editorMachine } from "./machine/editorMachine";
import type { EditorMachineInput, RecordingSession, StartRecordingEvent } from "./machine/types";
import type {
  CaptionTrack,
  EditorSelection,
  Recording,
  RecordingChapter,
  RecordingStreamDelta,
} from "./types";
import type {
  PreviewDomPatchBatch,
  PreviewEvent,
  PreviewInitialDocument,
  SlideEvent,
} from "./slides";
import type { WhiteboardEvent } from "./whiteboard";
import type { ChatRecordingEvent } from "../../types/chat";
import type { TextEditEvent } from "../../types/textEdit";
import type { WorkspaceRecordingSnapshot, WorkspaceWidthDeltas } from "../../types/workspace";
import { isAtPlaybackEnd } from "./machine/editorMachineHelpers";
import { isRecordingClockPaused, type RecordingClock } from "./machine/recordingClock";
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
// Selectors: plain functions of a snapshot, not memoized. useSelector re-renders its
// component whenever a selector's result changes, by reference unless the caller passes
// a compare function, so each returns the same value until what it reports changes.
// ============================================================================

const getPlaybackState = (state: EditorMachineSnapshot): "playing" | "paused" | "ended" | null => {
  if (state.matches({ playback: "playing" })) return "playing";
  if (state.matches({ playback: "paused" })) return "paused";
  if (state.matches({ playback: "ended" })) return "ended";
  return null;
};

/** The take's session while it records (running or paused), or null. */
const getRunningSession = (state: EditorMachineSnapshot): RecordingSession | null =>
  state.matches("recording") ? state.context.session : null;

/**
 * Every flag useNextEditorMetadata exposes, from one pass over the snapshot. The hook
 * compares the result with shallowEqual, so consumers re-render only when a field
 * changes, not on every TICK or captured frame.
 */
export const selectNextEditorMetadata = (state: EditorMachineSnapshot) => {
  const playbackState = getPlaybackState(state);
  const runningSession = getRunningSession(state);
  return {
    isRecording: state.matches("recording"),
    isRecordingPaused: runningSession !== null && isRecordingClockPaused(runningSession.clock),
    isPlaying: playbackState === "playing",
    hasEnded: playbackState === "ended" && isAtPlaybackEnd(state.context.timeline),
    usesPlaybackModel: !state.context.hasManualWorkspaceOverride && playbackState !== null,
    currentRecording: state.context.recording,
  };
};

/**
 * A take is starting, recording (or paused) or being finalized. Until it is finalized it
 * lives only in this tab.
 */
export const selectIsTakeInProgress = (state: EditorMachineSnapshot) =>
  state.matches("startingRecording") ||
  state.matches("recording") ||
  state.matches("stoppingRecording");

// Playback state selectors
export const selectIsPlaying = (state: EditorMachineSnapshot) =>
  state.matches({ playback: "playing" });

// Timeline selectors (high-frequency updates)
export const selectPlaybackSpeed = (state: EditorMachineSnapshot) => state.context.timeline.speed;
export const selectVolume = (state: EditorMachineSnapshot) => state.context.timeline.volume;
export const selectDuration = (state: EditorMachineSnapshot) => state.context.timeline.duration;
export const selectLiveTime = (state: EditorMachineSnapshot) => state.context.timeline.currentTime;

/**
 * What the recording timer reads: the running take's clock and origin, or null outside a
 * take. The clock is replaced on every pause and resume, so the pair changes only then.
 */
export const selectRecordingClock = (
  state: EditorMachineSnapshot,
): { clock: RecordingClock; startedAtPerf: number } | null => {
  const session = getRunningSession(state);
  return session ? { clock: session.clock, startedAtPerf: session.startedAtPerf } : null;
};

/**
 * The running take's microphone stream (for a level meter), or null outside a microphone
 * take. It is the recorder's own stream: metering it shows what is being recorded.
 */
export const selectRecordingMicrophoneStream = (state: EditorMachineSnapshot) =>
  state.matches("recording") && state.context.audio.source === "microphone"
    ? (state.context.audio.mediaRecorder?.stream ?? null)
    : null;

/** How many chapters the running take has marked (0 outside a take). */
export const selectRecordingChapterCount = (state: EditorMachineSnapshot) =>
  getRunningSession(state)?.chapters.length ?? 0;

/** Where a retake can rewind to, or null outside a take. Replaced whenever it changes. */
export const selectRecordingSafePoints = (state: EditorMachineSnapshot) => {
  const session = getRunningSession(state);
  return session ? session.safePoints : null;
};

// Data selectors
export const selectRecording = (state: EditorMachineSnapshot) => state.context.recording;
const selectEditor = (state: EditorMachineSnapshot) => state.context.editorRefs.editor;

const createNextEditorActorActions = (actorRef: EditorActorRef) => {
  // Recording Controls
  const startRecording = (options?: Omit<StartRecordingEvent, "type">) => {
    actorRef.send({
      type: "START_RECORDING",
      audioBlob: options?.audioBlob,
      enableCamera: options?.enableCamera,
      screenStream: options?.screenStream,
      microphoneDeviceId: options?.microphoneDeviceId,
    });
  };

  const stopRecording = () => {
    actorRef.send({ type: "STOP_RECORDING" });
  };

  const pauseRecording = () => {
    actorRef.send({ type: "PAUSE_RECORDING" });
  };

  const resumeRecording = () => {
    actorRef.send({ type: "RESUME_RECORDING" });
  };

  const retakeRecording = () => {
    actorRef.send({ type: "RETAKE_RECORDING" });
  };

  const addChapterMarker = (title?: string) => {
    actorRef.send({ type: "ADD_CHAPTER_MARKER", title });
  };

  const setChapters = (recordingId: string, chapters: RecordingChapter[]) => {
    actorRef.send({ type: "SET_CHAPTERS", recordingId, chapters });
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

  const restoreLearnerWorkspace = (recordingTime: number, snapshot: WorkspaceRecordingSnapshot) => {
    actorRef.send({ type: "RESTORE_LEARNER_WORKSPACE", recordingTime, snapshot });
  };

  const preserveLearnerWorkspace = () => {
    actorRef.send({ type: "PRESERVE_LEARNER_WORKSPACE" });
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

  const appendRecordingDelta = (delta: RecordingStreamDelta) => {
    actorRef.send({ type: "APPEND_RECORDING_DELTA", delta });
  };

  const addCaptionTrack = (recordingId: string, track: CaptionTrack) => {
    actorRef.send({ type: "ADD_CAPTION_TRACK", recordingId, track });
  };

  const clearRecording = () => {
    actorRef.send({ type: "UNLOAD" });
  };

  const syncEditorRef = (nextEditor: monaco.editor.IStandaloneCodeEditor | null) => {
    actorRef.send({ type: "SET_EDITOR_REF", editor: nextEditor });
  };

  // Event Handlers for UI
  const handleEditorChange = (selection?: EditorSelection, textEdit?: TextEditEvent) => {
    actorRef.send({ type: "CAPTURE_FRAME", selection, textEdit });
  };

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

  const handleWorkspaceEvent = (event?: WorkspaceWidthDeltas) => {
    actorRef.send({
      type: "WORKSPACE_EVENT",
      sidebarWidthDelta: event?.sidebarWidthDelta,
      previewDockWidthDelta: event?.previewDockWidthDelta,
    });
  };

  const handleRuntimeEvent = () => {
    actorRef.send({ type: "RUNTIME_EVENT" });
  };

  const handleWhiteboardEvent = (event: WhiteboardEvent) => {
    actorRef.send({ type: "WHITEBOARD_EVENT", event });
  };

  const handleChatEvent = (event: ChatRecordingEvent["event"]) => {
    actorRef.send({ type: "CHAT_EVENT", event });
  };

  return {
    startRecording,
    stopRecording,
    /** Stop the take's clock and recorders without ending the take. */
    pauseRecording,
    /** Run a paused take's clock and recorders again. */
    resumeRecording,
    /**
     * Discard what the take recorded since its last safe point (its start, or the last
     * resume), put the editor back, and hold the take paused there.
     */
    retakeRecording,
    /** Mark a chapter at the take's current moment (also a safe point for retakes). */
    addChapterMarker,
    /** Replace the loaded recording's chapters. */
    setChapters,
    play,
    pause,
    stop,
    seekTo,
    /** Pause and bring back the viewer's saved edits where they were made. */
    restoreLearnerWorkspace,
    /** Save the viewer's edits now, if they have any. */
    preserveLearnerWorkspace,
    setPlaybackSpeed,
    setVolume,
    loadRecording,
    extendRecording,
    appendRecordingDelta,
    addCaptionTrack,
    clearRecording,
    syncEditorRef,
    handleEditorChange,
    handleSlideEvent,
    handlePreviewEvent,
    handlePreviewInitialDocument,
    handlePreviewPatchBatch,
    handleWorkspaceEvent,
    handleRuntimeEvent,
    handleWhiteboardEvent,
    handleChatEvent,
  };
};

/** The machine's event senders, as useNextEditorActorActions returns them. */
export type NextEditorActorActions = ReturnType<typeof createNextEditorActorActions>;

/**
 * Action senders that close over the stable actorRef — subscription-free by design.
 * Consumers that only dispatch events (e.g. the provider's actions context) can use
 * this without re-rendering on machine state transitions.
 *
 * Memoized via useState rather than relying on the React Compiler: this hook
 * contains no React hook calls in its action bodies, so the compiler skips it
 * entirely (no memo cache is emitted) and every render would otherwise produce
 * fresh sender identities. That churn is not cosmetic — CodeEditor keys its
 * unmount-cleanup effect on `syncEditorRef`, and that cleanup nulls
 * `editorRef.current` and detaches the editor from the machine, so unstable
 * identities silently break frame/cursor capture and replay.
 */
export const useNextEditorActorActions = (actorRef: EditorActorRef) => {
  const [cache, setCache] = useState(() => ({
    actorRef,
    actions: createNextEditorActorActions(actorRef),
  }));
  // Render-phase adjustment (not an effect) so a swapped actor — e.g. HMR
  // replacing the machine — never leaves senders pointing at a stopped actor.
  if (cache.actorRef !== actorRef) {
    setCache({ actorRef, actions: createNextEditorActorActions(actorRef) });
  }
  return cache.actions;
};

/**
 * Side-effect-only companion to useNextEditorActorActions: keeps the machine's
 * editor ref in sync and pauses playback on user interaction. Subscribes only to
 * the slices those effects need (isPlaying, editor); returns nothing.
 */
export const useNextEditorInteractionEffects = (
  actorRef: EditorActorRef,
  editorRef: EditorMachineInput["editorRef"],
): void => {
  const isPlaying = useSelector(actorRef, selectIsPlaying);
  const editor = useSelector(actorRef, selectEditor);

  // Keep the machine's editor ref attached. SET_EDITOR_REF sends are silently
  // discarded while the actor is stopped (StrictMode/Suspense effect reconnects
  // rehydrate the actor via stop+restart), so a single missed send must not be
  // permanent. This used to self-heal by accident: the provider once subscribed
  // to a dozen selectors, re-rendered on every machine transition, and a dep-less
  // effect re-sent the ref. Re-assert deliberately instead: once on mount and
  // after every machine transition, via an actor subscription (no re-renders).
  // Events sent to a not-yet-(re)started actor are buffered and flush on start.
  useEffect(() => {
    const syncEditorRefIfStale = () => {
      const currentEditor = editorRef.current;
      if (currentEditor && actorRef.getSnapshot().context.editorRefs.editor !== currentEditor) {
        actorRef.send({ type: "SET_EDITOR_REF", editor: currentEditor });
      }
    };
    syncEditorRefIfStale();
    const subscription = actorRef.subscribe(syncEditorRefIfStale);
    return () => {
      subscription.unsubscribe();
    };
  }, [actorRef, editorRef]);

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
};
