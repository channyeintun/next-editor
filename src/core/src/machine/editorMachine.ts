import {
  setup,
  assign,
  spawnChild,
  stopChild,
  fromCallback,
  enqueueActions,
  fromPromise,
} from "xstate";
import type * as monaco from "monaco-editor";
import type { SlideEvent, PreviewEvent } from "../slides";
import type {
  EditorMachineContext,
  EditorMachineEvent,
  EditorMachineInput,
} from "./types";
import type { EditorFrame, Recording } from "../types";
import {
  compressFrames,
  reconstructFrameAtIndex,
  applyFrameDelta,
  findFrameIndexAtTime,
  isKeyframe,
} from "../utils/frameDelta";
import { timelineMachine } from "./timelineMachine";
import { audioRecordingActor, audioPlaybackActor } from "./audioActor";
import {
  applyContentDiff,
  applyPositionDiff,
  applySelectionDiff,
  areSelectionsEqual,
} from "../utils/editorDiff";
import { isValidFrameState, isEditorReady } from "../utils/validation";
import { calculateDurationFromFileReader } from "../utils/audioDuration";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Apply editor state from a frame
 */
const applyFrameState = (
  editor: monaco.editor.IStandaloneCodeEditor,
  frame: EditorFrame,
  decorationsCollection: monaco.editor.IEditorDecorationsCollection | null,
  isPlaying: boolean,
  previousFrame?: EditorFrame | null,
): monaco.editor.IEditorDecorationsCollection | null => {
  if (!frame.state || !isEditorReady(editor)) return decorationsCollection;

  let collection = decorationsCollection;

  try {
    // Apply content changes
    applyContentDiff(editor, frame.state.content, previousFrame?.state.content);

    // Apply position and selection
    applyPositionDiff(
      editor,
      frame.state.position,
      previousFrame?.state.position,
    );
    applySelectionDiff(
      editor,
      frame.state.selection,
      previousFrame?.state.selection,
    );

    // Add cursor decorations during playback
    if (isPlaying) {
      // Only update decorations if selection changed or collection is missing
      const selectionChanged =
        !previousFrame ||
        !areSelectionsEqual(
          previousFrame.state.selection,
          frame.state.selection,
        );

      if (selectionChanged || !collection) {
        const newDecorations: monaco.editor.IModelDeltaDecoration[] = [];
        const currentSelections = editor.getSelections() || [
          frame.state.selection,
        ];

        currentSelections.forEach((selection) => {
          const Range = (window as unknown as { monaco: typeof monaco }).monaco
            .Range;
          newDecorations.push({
            range: new Range(
              selection.positionLineNumber,
              selection.positionColumn,
              selection.positionLineNumber,
              selection.positionColumn,
            ),
            options: {
              className: "playback-cursor-decoration",
              stickiness: 1, // NeverGrowsWhenTypingAtEdges
              minimap: {
                color: "#007ACC",
                position: 1, // Inline
              },
              overviewRuler: {
                color: "#007ACC",
                position: 2, // Center
              },
            },
          });
        });

        // Create collection if it doesn't exist, otherwise update it
        if (!collection) {
          collection = editor.createDecorationsCollection(newDecorations);
        } else {
          collection.set(newDecorations);
        }
      }
    }

    // Restore view state (scrolling, etc.)
    if (
      frame.state.viewState &&
      (!previousFrame ||
        JSON.stringify(frame.state.viewState) !==
          JSON.stringify(previousFrame.state.viewState))
    ) {
      try {
        editor.restoreViewState(frame.state.viewState);
      } catch (err) {
        console.error("Failed to restore view state:", err);
      }
    }
  } catch (error) {
    console.error("Error applying editor state:", error);
  }

  return collection;
};

/**
 * Create a frame from current editor state
 */
const createFrame = (
  editor: monaco.editor.IStandaloneCodeEditor,
  timestamp: number,
  mouseCursor: { x: number; y: number; visible: boolean },
  getSlideState?: EditorMachineInput["getSlideState"],
  getPreviewState?: EditorMachineInput["getPreviewState"],
): EditorFrame => {
  const content = editor.getValue();
  const selection = editor.getSelection();
  const position = editor.getPosition();
  const viewState = editor.saveViewState();
  const slideState = getSlideState?.();
  const previewState = getPreviewState?.();

  return {
    timestamp,
    state: {
      content,
      selection: selection || {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 1,
        selectionStartLineNumber: 1,
        selectionStartColumn: 1,
        positionLineNumber: 1,
        positionColumn: 1,
      },
      position: position || { lineNumber: 1, column: 1 },
      viewState,
      mouseCursor,
      slideState: slideState?.previewState,
      currentSlideIndex: slideState?.currentSlideIndex,
      previewState: previewState || undefined,
    },
  };
};

/**
 * Find the appropriate frame for a given timestamp (optimized)
 */

// ============================================================================
// Mouse Tracking Actor
// ============================================================================

interface MouseTrackingInput {
  onMouseMove: (pos: { x: number; y: number; visible: boolean }) => void;
}

const mouseTrackingActor = fromCallback<{ type: "STOP" }, MouseTrackingInput>(
  ({ input }) => {
    const handleMouseMove = (e: MouseEvent) => {
      input.onMouseMove({ x: e.clientX, y: e.clientY, visible: true });
    };

    const handleMouseLeave = () => {
      input.onMouseMove({ x: 0, y: 0, visible: false });
    };

    // Handle iframe mouse tracking
    const iframeListeners = new Map<
      HTMLIFrameElement,
      { move: (e: MouseEvent) => void; leave: () => void }
    >();
    const iframeLoadHandlers = new Map<HTMLIFrameElement, () => void>();

    const setupIframeListeners = (iframe: HTMLIFrameElement) => {
      const onIframeMouseMove = (e: MouseEvent) => {
        const rect = iframe.getBoundingClientRect();
        input.onMouseMove({
          x: rect.left + e.clientX,
          y: rect.top + e.clientY,
          visible: true,
        });
      };

      const onIframeMouseLeave = () => {
        input.onMouseMove({ x: 0, y: 0, visible: false });
      };

      const attachToDocument = () => {
        try {
          const iframeDoc =
            iframe.contentDocument || iframe.contentWindow?.document;
          if (!iframeDoc) return;

          // Clean up existing listeners if any
          const existing = iframeListeners.get(iframe);
          if (existing) {
            iframeDoc.removeEventListener("mousemove", existing.move);
            iframeDoc.removeEventListener("mouseleave", existing.leave);
          }

          iframeDoc.addEventListener("mousemove", onIframeMouseMove, true);
          iframeDoc.addEventListener("mouseleave", onIframeMouseLeave, true);

          iframeListeners.set(iframe, {
            move: onIframeMouseMove,
            leave: onIframeMouseLeave,
          });
        } catch (err) {
          // Likely cross-origin
          console.error("Cannot track mouse in iframe (cross-origin):", err);
        }
      };

      const handleLoad = () => {
        attachToDocument();
      };

      iframe.addEventListener("load", handleLoad);
      iframeLoadHandlers.set(iframe, handleLoad);
      attachToDocument();
    };

    const removeIframeListeners = (iframe: HTMLIFrameElement) => {
      const handlers = iframeListeners.get(iframe);
      const loadHandler = iframeLoadHandlers.get(iframe);

      if (loadHandler) {
        iframe.removeEventListener("load", loadHandler);
        iframeLoadHandlers.delete(iframe);
      }

      if (handlers) {
        try {
          const iframeDoc =
            iframe.contentDocument || iframe.contentWindow?.document;
          if (iframeDoc) {
            iframeDoc.removeEventListener("mousemove", handlers.move);
            iframeDoc.removeEventListener("mouseleave", handlers.leave);
          }
        } catch (err) {
          console.error("Error removing iframe listeners:", err);
        }
        iframeListeners.delete(iframe);
      }
    };

    // Listen for new iframes and content changes
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === "childList") {
          mutation.addedNodes.forEach((node) => {
            if (node instanceof HTMLIFrameElement) {
              setupIframeListeners(node);
            } else if (node instanceof HTMLElement) {
              node.querySelectorAll("iframe").forEach(setupIframeListeners);
            }
          });
          mutation.removedNodes.forEach((node) => {
            if (node instanceof HTMLIFrameElement) {
              removeIframeListeners(node);
            } else if (node instanceof HTMLElement) {
              node.querySelectorAll("iframe").forEach(removeIframeListeners);
            }
          });
        } else if (
          mutation.type === "attributes" &&
          mutation.target instanceof HTMLIFrameElement
        ) {
          if (
            mutation.attributeName === "src" ||
            mutation.attributeName === "srcdoc"
          ) {
            setupIframeListeners(mutation.target);
          }
        }
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcdoc"],
    });

    // Initial setup
    document.querySelectorAll("iframe").forEach(setupIframeListeners);
    document.addEventListener("mousemove", handleMouseMove, true);
    document.addEventListener("mouseleave", handleMouseLeave, true);

    return () => {
      observer.disconnect();
      document.removeEventListener("mousemove", handleMouseMove, true);
      document.removeEventListener("mouseleave", handleMouseLeave, true);

      // Clean up load listeners
      iframeLoadHandlers.forEach((handler, iframe) => {
        iframe.removeEventListener("load", handler);
      });
      iframeLoadHandlers.clear();

      iframeListeners.forEach((handlers, iframe) => {
        try {
          const iframeDoc =
            iframe.contentDocument || iframe.contentWindow?.document;
          if (iframeDoc) {
            iframeDoc.removeEventListener("mousemove", handlers.move);
            iframeDoc.removeEventListener("mouseleave", handlers.leave);
          }
        } catch (err) {
          console.error("Failed to cleanup iframe listeners:", err);
        }
      });
      iframeListeners.clear();
    };
  },
);

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
    audioPlayback: audioPlaybackActor,
    mouseTracking: mouseTrackingActor,
    loadRecording: fromPromise<
      { recording: Recording; duration: number },
      { recording: Recording }
    >(async ({ input }) => {
      let duration = input.recording.duration;

      const audioBlob = input.recording.audioBlob;
      if (audioBlob instanceof Blob) {
        try {
          const exactDuration =
            await calculateDurationFromFileReader(audioBlob);
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
    hasAudio: ({ context }) => context.recording?.audioBlob !== undefined,
    shouldPauseOnInteraction: ({ context }) => context.pauseOnUserInteraction,
    isValidSeekTime: ({ context, event }) => {
      if (event.type !== "SEEK") return false;
      return event.time >= 0 && event.time <= context.timeline.duration;
    },
  },
  actions: {
    // Recording actions
    initRecordingSession: assign(({ context }) => {
      const startedAt = Date.now();
      const slideEvents: SlideEvent[] = [];
      const previewEvents: PreviewEvent[] = [];

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
          content: initialPreviewState.content,
          scrollTop: initialPreviewState.scrollTop,
          scrollLeft: initialPreviewState.scrollLeft,
        });
      }

      return {
        session: {
          startedAt,
          frames: [],
          slideEvents,
          previewEvents,
          lastMousePosition: { x: 0, y: 0, visible: false },
        },
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

      return {
        session: {
          ...session,
          frames: [initialFrame],
        },
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

      const frame = createFrame(
        editor,
        timestamp,
        mousePosition,
        context.getSlideState,
        context.getPreviewState,
      );

      return {
        session: {
          ...context.session,
          frames: [...context.session.frames, frame],
          lastMousePosition: mousePosition,
        },
        currentFrame: frame,
      };
    }),

    finalizeRecording: assign(({ context }) => {
      if (!context.session) return { recording: null };

      // Base duration from session timing
      const duration = Math.max(Date.now() - context.session.startedAt, 1);
      const slides = context.getSlides?.();
      const workspaceSnapshot = context.getWorkspaceSnapshot?.() || undefined;
      const runtimeSnapshot = context.getRuntimeSnapshot?.() || undefined;

      // Compress frames into delta frames
      const frames = compressFrames(context.session.frames);

      const recording: Recording = {
        version: 3,
        id: Date.now().toString(),
        name: `Recording ${Date.now()}`,
        createdAt: Date.now(),
        frames,
        keyframeInterval: 120,
        slideEvents: context.session.slideEvents,
        previewEvents: context.session.previewEvents,
        slides: slides,
        duration,
        audioBlob: context.audio.blob || undefined,
        workspaceSnapshot,
        runtimeSnapshot,
      };

      return {
        recording,
        session: null,
        timeline: {
          ...context.timeline,
          duration,
        },
        lastAppliedFrameIndex: -1,
        lastAppliedPreviewEventIndex: -1,
        lastAppliedSlideEventIndex: -1,
      };
    }),

    // Playback actions
    setRecording: assign(({ context, event }) => {
      if (event.type !== "RECORDING_LOADED") return {};

      if (event.recording.slides && context.applySlides) {
        context.applySlides(event.recording.slides);
      }

      if (event.recording.workspaceSnapshot && context.applyWorkspaceSnapshot) {
        context.applyWorkspaceSnapshot(event.recording.workspaceSnapshot);
      }

      return {
        recording: event.recording,
        timeline: {
          currentTime: 0,
          duration: event.duration,
          speed: 1,
          volume: 1,
          startedAt: 0,
          pausedDuration: 0,
          pausedAt: 0,
        },
        lastAppliedFrameIndex: -1,
        lastAppliedPreviewEventIndex: -1,
        lastAppliedSlideEventIndex: -1,
      };
    }),

    applyFrameAtTime: assign(({ context, event }) => {
      const { recording, editorRefs, lastAppliedFrameIndex, currentFrame } =
        context;
      const currentTime =
        event.type === "TICK"
          ? event.currentTime
          : event.type === "SEEK"
            ? event.time
            : context.timeline.currentTime;

      if (!recording || !editorRefs.editor) {
        return {};
      }

      const frames = recording.frames;
      if (!frames?.length) return {};

      const frameIndex = findFrameIndexAtTime(
        frames,
        currentTime,
        lastAppliedFrameIndex,
      );

      if (frameIndex === lastAppliedFrameIndex) {
        return {};
      }

      let frame: EditorFrame | null = null;
      const targetFrame = frames[frameIndex];

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
            frame.state.slideState.currentSlideId !==
              prevSlideState.currentSlideId ||
            frame.state.slideState.indexv !== prevSlideState.indexv ||
            frame.state.currentSlideIndex !== prevSlideIndex;

          if (hasChanged) {
            context.applySlideState(
              frame.state.slideState,
              frame.state.currentSlideIndex,
            );
          }
        }
      }

      if (frame.state.previewState && context.applyPreviewState) {
        const nextState = frame.state.previewState;
        const currentState = context.lastAppliedPreviewState;

        if (!recording.previewEvents?.length) {
          if (
            !currentState ||
            JSON.stringify(nextState.size) !==
              JSON.stringify(currentState.size) ||
            nextState.content !== currentState.content ||
            Math.abs(
              (nextState.scrollTop || 0) - (currentState.scrollTop || 0),
            ) > 1 ||
            Math.abs(
              (nextState.scrollLeft || 0) - (currentState.scrollLeft || 0),
            ) > 1
          ) {
            context.applyPreviewState(nextState);
            updates.lastAppliedPreviewState = nextState;
          }
        }
      }

      return updates;
    }),

    seekToTime: assign(({ context, event }) => {
      if (event.type !== "SEEK") return {};
      const clampedTime = Math.max(
        0,
        Math.min(event.time, context.timeline.duration),
      );
      return {
        timeline: {
          ...context.timeline,
          currentTime: clampedTime,
        },
        lastAppliedFrameIndex: -1,
        lastAppliedSlideEventIndex: -1,
        lastAppliedPreviewEventIndex: -1,
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

    restoreRecordedFrameFromPause: ({ context }) => {
      const { editorRefs, recordedFrameAtPause } = context;
      if (
        !editorRefs.editor ||
        !recordedFrameAtPause ||
        !recordedFrameAtPause.state
      ) {
        return;
      }

      // Force restore the exact recorded frame by setting all state directly
      try {
        const model = editorRefs.editor.getModel();
        if (model) {
          model.setValue(recordedFrameAtPause.state.content);
        }
        editorRefs.editor.setPosition(recordedFrameAtPause.state.position);
        editorRefs.editor.setSelection(recordedFrameAtPause.state.selection);
        if (recordedFrameAtPause.state.viewState) {
          editorRefs.editor.restoreViewState(
            recordedFrameAtPause.state.viewState,
          );
        }
      } catch (error) {
        console.error("Error restoring recorded frame from pause:", error);
      }
    },

    resetPlayback: assign(({ context }) => ({
      timeline: {
        ...context.timeline,
        currentTime: 0,
        startedAt: 0,
        pausedDuration: 0,
        pausedAt: 0,
      },
      currentFrame: null,
      lastAppliedFrameIndex: -1,
      lastAppliedPreviewEventIndex: -1,
      lastAppliedSlideEventIndex: -1,
      lastAppliedPreviewState: undefined,
    })),

    clearRecording: assign({
      recording: null,
      currentFrame: null,
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
        },
      };
    }),

    setEditorRef: assign(({ context, event }) => {
      if (
        event.type !== "SET_EDITOR_REF" ||
        event.editor === context.editorRefs.editor
      ) {
        return {};
      }
      return {
        editorRefs: {
          ...context.editorRefs,
          editor: event.editor,
        },
      };
    }),

    applyPreviewEventsAtTime: assign(({ context, event }) => {
      const { recording, applyPreviewState, lastAppliedPreviewEventIndex } =
        context;

      if (!recording?.previewEvents?.length || !applyPreviewState) {
        return {};
      }

      const previewEvents = recording.previewEvents;
      const currentTime =
        event.type === "TICK"
          ? event.currentTime
          : event.type === "SEEK"
            ? event.time
            : context.timeline.currentTime;
      let newLastIndex = lastAppliedPreviewEventIndex;
      let nextAppliedPreviewState = context.lastAppliedPreviewState;

      // If we've jumped backwards, reset the index to re-scan from the beginning
      if (newLastIndex >= 0 && newLastIndex < previewEvents.length) {
        if (previewEvents[newLastIndex].timestamp > currentTime) {
          newLastIndex = -1;
        }
      }

      // Find and apply all events that should have happened by now
      let latestStateEvent: PreviewEvent | null = null;
      let latestContent: string | undefined = undefined;
      const isSeeking = event.type === "SEEK";

      for (let i = newLastIndex + 1; i < previewEvents.length; i++) {
        const previewEvent = previewEvents[i];
        if (previewEvent.timestamp <= currentTime) {
          if (isSeeking) {
            // When seeking, just keep track of the last state-defining event
            // and skip interaction events (clicks, etc.)
            if (previewEvent.type !== "preview_interaction") {
              latestStateEvent = previewEvent;
              if (previewEvent.content) {
                latestContent = previewEvent.content;
              }
            }
          } else {
            // Normal playback: apply events sequentially for interactions
            const nextState = {
              size: previewEvent.size || "small",
              content: previewEvent.content,
              scrollTop: previewEvent.scrollTop,
              scrollLeft: previewEvent.scrollLeft,
              currentInteraction: previewEvent.interaction,
            };

            applyPreviewState(nextState);
            nextAppliedPreviewState = nextState;
          }
          newLastIndex = i;
        } else {
          // Events are sorted by timestamp, so stop here
          break;
        }
      }

      // If we were seeking, apply only the final combined state once
      if (isSeeking) {
        // If we didn't find content in the current scanned range,
        // we might need to look back for the latest content BEFORE newLastIndex
        if (latestStateEvent && !latestContent) {
          for (let j = newLastIndex; j >= 0; j--) {
            if (previewEvents[j].content) {
              latestContent = previewEvents[j].content;
              break;
            }
          }
        }

        if (latestStateEvent) {
          const finalState = {
            size: latestStateEvent.size || "small",
            content: latestContent,
            scrollTop: latestStateEvent.scrollTop,
            scrollLeft: latestStateEvent.scrollLeft,
            // Note: interactions are skipped during seek
          };
          applyPreviewState(finalState);
          nextAppliedPreviewState = finalState;
        }
      }

      if (
        newLastIndex !== lastAppliedPreviewEventIndex ||
        nextAppliedPreviewState !== context.lastAppliedPreviewState
      ) {
        return {
          lastAppliedPreviewEventIndex: newLastIndex,
          lastAppliedPreviewState: nextAppliedPreviewState,
        };
      }

      return {};
    }),
    applySlideEventsAtTime: assign(({ context, event }) => {
      const { recording, applySlideState, lastAppliedSlideEventIndex } =
        context;

      if (!recording?.slideEvents?.length || !applySlideState) {
        return {};
      }

      const slideEvents = recording.slideEvents;
      const currentTime =
        event.type === "TICK"
          ? event.currentTime
          : event.type === "SEEK"
            ? event.time
            : context.timeline.currentTime;
      let newLastIndex = lastAppliedSlideEventIndex;
      const isSeeking = event.type === "SEEK";

      // If we've jumped backwards, reset the index to re-scan from the beginning
      if (newLastIndex >= 0 && newLastIndex < slideEvents.length) {
        if (slideEvents[newLastIndex].timestamp > currentTime) {
          newLastIndex = -1;
        }
      }

      let lastSlideEvent = null;

      // Find and apply all events that should have happened by now
      for (let i = newLastIndex + 1; i < slideEvents.length; i++) {
        const slideEvent = slideEvents[i];
        if (slideEvent.timestamp <= currentTime) {
          if (isSeeking) {
            // When seeking, just keep track of the last event to apply once at the end
            lastSlideEvent = slideEvent;
          } else {
            // Normal playback: apply events sequentially
            const slideIndex =
              recording.slides?.findIndex((s) => s.id === slideEvent.slideId) ??
              -1;
            if (slideIndex !== -1 || slideEvent.type === "slide_close") {
              let slideState;

              if (slideEvent.type === "slide_close") {
                slideState = {
                  isOpen: false,
                  currentSlideId: null,
                  indexv: 0,
                  currentInteraction: undefined,
                };
              } else {
                // Full derivation for all other events (open, change, interaction, maximize, minimize)
                const relevantEvents = slideEvents.slice(0, i + 1).reverse();

                // Find the most recent navigation event that defines the current location
                const lastNav = relevantEvents.find((e) =>
                  ["slide_open", "slide_change", "slide_close"].includes(
                    e.type,
                  ),
                );

                // Find the most recent state-defining event to preserve structural state (maximize, etc.)
                const lastStructural = relevantEvents.find((e) =>
                  ["slide_maximize", "slide_minimize"].includes(e.type),
                );

                // Most important: always look for the LAST KNOWN indexv for THIS slide
                // if the current event doesn't have it (e.g. structural change or back-navigation without indexv)
                const targetSlideId = slideEvent.slideId || lastNav?.slideId;
                const lastWithIndexv = relevantEvents.find(
                  (e) =>
                    (targetSlideId ? e.slideId === targetSlideId : true) &&
                    e.indexv !== undefined &&
                    e.indexv !== null,
                );

                slideState = {
                  isOpen: (lastNav?.type || slideEvent.type) !== "slide_close",
                  isMaximized: lastStructural
                    ? lastStructural.type === "slide_maximize"
                    : (slideEvent.isMaximized ?? lastNav?.isMaximized ?? false),
                  currentSlideId:
                    slideEvent.slideId || lastNav?.slideId || null,
                  indexv:
                    slideEvent.indexv ??
                    lastWithIndexv?.indexv ??
                    lastNav?.indexv,
                  currentInteraction: slideEvent.interaction,
                };
              }
              applySlideState(slideState, slideIndex);
            }
          }
          newLastIndex = i;
        } else {
          break;
        }
      }

      // If we were seeking, apply only the final state once
      if (isSeeking && lastSlideEvent) {
        const slideIndex =
          recording.slides?.findIndex((s) => s.id === lastSlideEvent.slideId) ??
          -1;
        // Find the most recent navigation event for this slide to ensure we seek to the correct state
        const relevantEvents = slideEvents.slice(0, newLastIndex + 1).reverse();

        const lastNav = relevantEvents.find((e) =>
          ["slide_open", "slide_change", "slide_close"].includes(e.type),
        );

        const lastStructural = relevantEvents.find((e) =>
          ["slide_maximize", "slide_minimize"].includes(e.type),
        );

        const targetSearchSlideId = lastSlideEvent.slideId || lastNav?.slideId;
        const lastWithIndexv = relevantEvents.find(
          (e) =>
            (targetSearchSlideId ? e.slideId === targetSearchSlideId : true) &&
            e.indexv !== undefined &&
            e.indexv !== null,
        );

        const slideState = {
          isOpen: (lastNav?.type || lastSlideEvent.type) !== "slide_close",
          isMaximized: lastStructural
            ? lastStructural.type === "slide_maximize"
            : (lastSlideEvent.isMaximized ?? lastNav?.isMaximized ?? false),
          currentSlideId: lastSlideEvent.slideId || lastNav?.slideId || null,
          indexv:
            lastSlideEvent.indexv ?? lastWithIndexv?.indexv ?? lastNav?.indexv,
          currentInteraction: lastSlideEvent.interaction,
        };
        applySlideState(slideState, slideIndex);
      }

      if (newLastIndex !== lastAppliedSlideEventIndex) {
        return {
          lastAppliedSlideEventIndex: newLastIndex,
        };
      }

      return {};
    }),
  },
}).createMachine({
  id: "editor",
  context: ({ input }) => ({
    timeline: {
      currentTime: 0,
      duration: 0,
      speed: input.defaultPlaybackSpeed ?? 1,
      volume: 1,
      startedAt: 0,
      pausedDuration: 0,
      pausedAt: 0,
    },
    session: null,
    recording: null,
    currentFrame: null,
    audio: {
      blob: null,
      element: null,
      isRecording: false,
      mediaRecorder: null,
      chunks: [],
      mimeType: "",
    },
    editorRefs: {
      editor: input.editorRef.current,
      cursorDecorationsCollection: null,
    },
    enableAudioRecording: input.enableAudioRecording ?? false,
    pauseOnUserInteraction: input.pauseOnUserInteraction ?? true,
    animationFrameId: null,
    error: null,
    lastAppliedFrameIndex: -1,
    lastAppliedPreviewEventIndex: -1,
    lastAppliedSlideEventIndex: -1,
    applySlideState: input.applySlideState,
    applySlides: input.applySlides,
    getSlideState: input.getSlideState,
    getSlides: input.getSlides,
    applyPreviewState: input.applyPreviewState,
    getPreviewState: input.getPreviewState,
    getWorkspaceSnapshot: input.getWorkspaceSnapshot,
    applyWorkspaceSnapshot: input.applyWorkspaceSnapshot,
    getRuntimeSnapshot: input.getRuntimeSnapshot,
  }),

  initial: "idle",
  on: {
    SET_EDITOR_REF: {
      actions: [
        "setEditorRef",
        "applyFrameAtTime",
        "applyPreviewEventsAtTime",
        "applySlideEventsAtTime",
      ],
    },
  },
  states: {
    idle: {
      on: {
        START_RECORDING: [
          {
            target: "startingRecording",
            guard: ({ context }) => context.enableAudioRecording,
          },
          {
            target: "recording",
            actions: ["initRecordingSession", "captureInitialFrame"],
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
            audio: { ...context.audio, isRecording: true },
          });
        }),
      ],
      on: {
        STARTED: {
          target: "recording",
          actions: ["initRecordingSession", "captureInitialFrame"],
        },
        ERROR: {
          target: "idle",
          actions: assign({
            error: ({ event }) =>
              event.type === "ERROR" ? event.error : "Failed to start audio",
          }),
        },
        STOP_RECORDING: {
          target: "idle",
          actions: [
            stopChild("audioRecorder"),
            assign({
              audio: ({ context }) => ({
                ...context.audio,
                isRecording: false,
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
            onMouseMove: (pos: { x: number; y: number; visible: boolean }) => {
              self.send({
                type: "CAPTURE_FRAME",
                isMouseMovement: true,
                mousePosition: pos,
              });
            },
          }),
        }),
      ],
      exit: [],
      on: {
        CAPTURE_FRAME: {
          actions: "captureFrame",
        },
        STOPPED: {
          actions: "storeAudioBlob",
        },
        SLIDE_EVENT: {
          actions: [
            assign(({ context, event }) => {
              if (!context.session) return {};
              return {
                session: {
                  ...context.session,
                  slideEvents: [
                    ...context.session.slideEvents,
                    {
                      ...event.event,
                      timestamp: Date.now() - context.session.startedAt,
                    },
                  ],
                },
              };
            }),
            "captureFrame",
          ],
        },
        PREVIEW_EVENT: {
          actions: [
            assign(({ context, event }) => {
              if (!context.session) return {};
              return {
                session: {
                  ...context.session,
                  previewEvents: [
                    ...context.session.previewEvents,
                    {
                      ...event.event,
                      timestamp: Date.now() - context.session.startedAt,
                    },
                  ],
                },
              };
            }),
          ],
        },
        STOP_RECORDING: [
          {
            target: "stoppingRecording",
            guard: ({ context }) =>
              context.enableAudioRecording && context.audio.isRecording,
          },
          {
            target: "loading",
            actions: "finalizeRecording",
          },
        ],
      },
    },

    stoppingRecording: {
      entry: [
        stopChild("mouseTracker"),
        enqueueActions(({ enqueue }) => {
          enqueue.sendTo("audioRecorder", { type: "STOP" });
        }),
      ],
      exit: [stopChild("audioRecorder")],
      on: {
        STOPPED: {
          target: "loading",
          actions: ["storeAudioBlob", "finalizeRecording"],
        },
      },
      after: {
        2000: {
          target: "loading",
          actions: "finalizeRecording",
        },
      },
    },

    loading: {
      invoke: {
        src: "loadRecording",
        input: ({ context, event }) => {
          if (event.type === "LOAD_RECORDING")
            return { recording: event.recording };
          if (context.recording) return { recording: context.recording };
          throw new Error("No recording found to load");
        },
        onDone: {
          target: "playback.ready",
          actions: [
            assign({
              recording: ({ event }) => event.output.recording,
              timeline: ({ context, event }) => ({
                ...context.timeline,
                currentTime: 0,
                duration: Math.max(event.output.duration, 1),
                speed: 1,
                volume: 1,
                startedAt: 0,
                pausedDuration: 0,
                pausedAt: 0,
              }),
              currentFrame: null,
              lastAppliedFrameIndex: -1,
              lastAppliedPreviewEventIndex: -1,
              lastAppliedSlideEventIndex: -1,
            }),
            ({ context, event }) => {
              if (event.output.recording.slides && context.applySlides) {
                context.applySlides(event.output.recording.slides);
              }
            },
          ],
        },
        onError: {
          target: "idle",
          actions: assign({
            error: ({ event }) =>
              event.error instanceof Error
                ? event.error.message
                : "Failed to load recording",
          }),
        },
      },
    },

    playback: {
      initial: "ready",
      entry: [
        "applyFrameAtTime",
        enqueueActions(({ context, enqueue }) => {
          enqueue.spawnChild("timeline", {
            id: "timelineActor",
            input: {
              speed: context.timeline.speed,
              duration: context.timeline.duration,
              startPosition: context.timeline.currentTime,
            },
          });

          const audioBlob = context.recording?.audioBlob;
          if (audioBlob instanceof Blob) {
            enqueue.spawnChild("audioPlayback", {
              id: "audioPlayer",
              input: {
                blob: audioBlob,
                volume: context.timeline.volume,
                playbackRate: context.timeline.speed,
                startPosition: context.timeline.currentTime / 1000,
              },
            });
          }
        }),
      ],
      exit: [
        stopChild("timelineActor"),
        stopChild("audioPlayer"),
        "clearCursorDecorations",
      ],
      on: {
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
            "applyFrameAtTime",
            "applyPreviewEventsAtTime",
            "applySlideEventsAtTime",
            enqueueActions(({ context, event, enqueue }) => {
              // Sync audio to timeline every 250ms or on seek
              const lastSync = context.lastSyncTime || 0;
              const now = performance.now();
              if (now - lastSync > 250) {
                enqueue.sendTo("audioPlayer", {
                  type: "SYNC",
                  time: event.currentTime,
                });
                enqueue.assign({ lastSyncTime: now });
              }
            }),
          ],
        },
        SEEK: {
          actions: [
            "seekToTime",
            "applyFrameAtTime",
            "applyPreviewEventsAtTime",
            "applySlideEventsAtTime",
            enqueueActions(({ event, enqueue }) => {
              const time = event.type === "SEEK" ? event.time : 0;
              enqueue.sendTo("timelineActor", { type: "SEEK", time });
              enqueue.sendTo("audioPlayer", {
                type: "SEEK",
                time: time / 1000,
              });
            }),
          ],
        },
        SET_SPEED: {
          actions: [
            "setPlaybackSpeed",
            enqueueActions(({ event, enqueue }) => {
              const speed = event.type === "SET_SPEED" ? event.speed : 1;
              enqueue.sendTo("timelineActor", { type: "SET_SPEED", speed });
              enqueue.sendTo("audioPlayer", {
                type: "SET_PLAYBACK_RATE",
                rate: speed,
              });
            }),
          ],
        },
        SET_VOLUME: {
          actions: [
            "setVolume",
            enqueueActions(({ context, event, enqueue }) => {
              if (context.recording?.audioBlob instanceof Blob) {
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
            "resetPlayback",
            enqueueActions(({ enqueue }) => {
              enqueue.sendTo("timelineActor", { type: "SEEK", time: 0 });
              enqueue.sendTo("audioPlayer", { type: "SEEK", time: 0 });
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
            },
          },
        },

        playing: {
          entry: [
            "applyFrameAtTime",
            "applyPreviewEventsAtTime",
            "applySlideEventsAtTime",
            enqueueActions(({ context, enqueue }) => {
              enqueue.sendTo("timelineActor", { type: "START" });
              enqueue.sendTo("audioPlayer", { type: "PLAY" });
              // Ensure actors are at the machine's current time
              enqueue.sendTo("timelineActor", {
                type: "SEEK",
                time: context.timeline.currentTime,
              });
              enqueue.sendTo("audioPlayer", {
                type: "SEEK",
                time: context.timeline.currentTime / 1000,
              });
            }),
          ],
          exit: enqueueActions(({ enqueue }) => {
            enqueue.sendTo("timelineActor", { type: "PAUSE" });
            enqueue.sendTo("audioPlayer", { type: "PAUSE" });
          }),
          on: {
            PAUSE: {
              target: "paused",
            },
            USER_INTERACTION: {
              target: "paused",
              guard: "shouldPauseOnInteraction",
            },
            FINISHED: {
              target: "ended",
              actions: assign({
                timeline: ({ context }) => ({
                  ...context.timeline,
                  currentTime: context.timeline.duration,
                }),
              }),
            },
          },
        },

        paused: {
          entry: ["storeRecordedFrameAtPause"],
          on: {
            TICK: {
              actions: [
                "applyFrameAtTime",
                "applyPreviewEventsAtTime",
                "applySlideEventsAtTime",
                "storeRecordedFrameAtPause",
              ],
            },
            SEEK: {
              actions: [
                "seekToTime",
                "applyFrameAtTime",
                "applyPreviewEventsAtTime",
                "applySlideEventsAtTime",
                "storeRecordedFrameAtPause",
                enqueueActions(({ event, enqueue }) => {
                  const time = event.type === "SEEK" ? event.time : 0;
                  enqueue.sendTo("timelineActor", { type: "SEEK", time });
                  enqueue.sendTo("audioPlayer", {
                    type: "SEEK",
                    time: time / 1000,
                  });
                }),
              ],
            },
            PLAY: {
              target: "playing",
              actions: "restoreRecordedFrameFromPause",
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
                  context.timeline.duration - 100, // Fuzzy end check
                actions: [
                  "resetPlayback",
                  "applyFrameAtTime",
                  "applyPreviewEventsAtTime",
                  "applySlideEventsAtTime",
                  enqueueActions(({ enqueue }) => {
                    enqueue.sendTo("timelineActor", { type: "SEEK", time: 0 });
                    enqueue.sendTo("audioPlayer", { type: "SEEK", time: 0 });
                  }),
                ],
              },
              {
                target: "playing",
              },
            ],
          },
        },
      },
    },
  },
});
