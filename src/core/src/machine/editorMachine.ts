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
import type { EditorMachineContext, EditorMachineEvent, EditorMachineInput } from "./types";
import { createInitialContext } from "./types";
import type { CursorRecordingEvent, EditorFrame, MouseCursorPosition, Recording } from "../types";
import type { RuntimeRecordingEvent } from "../../../types/runtime";
import {
  areWorkspaceSnapshotsEqual,
  toSidebarWidthDeltaSnapshot,
  type WorkspaceRecordingEvent,
} from "../../../types/workspace";
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
import {
  normalizeEditorFrame,
  normalizeEditorPosition,
  normalizeEditorSelection,
  normalizeEditorViewState,
  normalizeRecordingData,
} from "../utils/editorState";
import { isValidFrameState, isEditorReady } from "../utils/validation";
import { calculateDurationFromFileReader } from "../utils/audioDuration";
import { arePreviewSizesEqual, areStructuredDataEqual } from "../../../utils/equality";
import {
  isRecordedCursorVisibilityDetail,
  RECORDED_CURSOR_VISIBILITY_EVENT,
} from "../../../utils/recordedCursorVisibility";
import {
  getPreviewReplayResult,
  getRuntimeReplayResult,
  getSlideReplayResult,
  getWorkspaceReplayResult,
  isSeekReplayEvent,
  resolveReplayTime,
} from "./replayState";
import {
  appendPreviewRecordingEvent,
  appendRuntimeRecordingEvent,
  appendSlideRecordingEvent,
  appendWorkspaceRecordingEvent,
} from "./recordingSession";
import { IFRAME_INTERACTION_MESSAGE_TYPE } from "../../../utils/iframeInteractionCapture";
import {
  areMouseCursorPositionsEqual,
  createCursorPositionFromClientPoint,
} from "../utils/cursorCoordinates";

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
  const normalizedFrame = normalizeEditorFrame(frame);

  try {
    // Apply content changes
    if (!previousFrame || previousFrame.state.content !== normalizedFrame.state.content) {
      applyContentDiff(editor, normalizedFrame.state.content, previousFrame?.state.content);
    }

    const viewStateChanged =
      !!normalizedFrame.state.viewState &&
      (!previousFrame ||
        !areStructuredDataEqual(normalizedFrame.state.viewState, previousFrame.state.viewState));

    // Restore scroll/layout first, then explicitly reapply selection so
    // Monaco cursorState inside viewState cannot override the recorded caret.
    if (viewStateChanged) {
      try {
        editor.restoreViewState(normalizedFrame.state.viewState);
      } catch (err) {
        console.error("Failed to restore view state:", err);
      }
    }

    applyPositionDiff(editor, normalizedFrame.state.position, editor.getPosition());
    applySelectionDiff(editor, normalizedFrame.state.selection, editor.getSelection());

    // Add cursor decorations during playback only when Monaco's own caret is
    // not visible. This avoids duplicate carets and preserves native
    // multi-cursor behavior while the editor has text focus.
    if (isPlaying && !editor.hasTextFocus()) {
      // Only update decorations if selection changed or collection is missing
      const selectionChanged =
        !previousFrame || !areSelectionsEqual(previousFrame.state.selection, frame.state.selection);

      if (selectionChanged || viewStateChanged || !collection) {
        const newDecorations: monaco.editor.IModelDeltaDecoration[] = [];
        const currentSelections = editor.getSelections() || [frame.state.selection];

        currentSelections.forEach((selection) => {
          const Range = (window as unknown as { monaco: typeof monaco }).monaco.Range;
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
    } else if (collection) {
      collection.clear();
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
  mouseCursor: MouseCursorPosition,
  getSlideState?: EditorMachineInput["getSlideState"],
  getPreviewState?: EditorMachineInput["getPreviewState"],
): EditorFrame => {
  const content = editor.getValue();
  const position = normalizeEditorPosition(editor.getPosition());
  const selection = normalizeEditorSelection(editor.getSelection(), undefined, position);
  const viewState = normalizeEditorViewState(editor.saveViewState(), selection, position);
  const slideState = getSlideState?.();
  const previewState = getPreviewState?.();

  return {
    timestamp,
    state: {
      content,
      selection,
      position,
      viewState,
      mouseCursor,
      slideState: slideState?.previewState,
      currentSlideIndex: slideState?.currentSlideIndex,
      previewState: previewState || undefined,
    },
  };
};

const getLoadedRecordingPayload = (
  context: EditorMachineContext,
  event: EditorMachineEvent | { output?: unknown },
): { recording: Recording; duration: number } | null => {
  if (
    "output" in event &&
    event.output &&
    typeof event.output === "object" &&
    "recording" in event.output &&
    "duration" in event.output
  ) {
    const output = event.output as { recording: Recording; duration: number };
    return output;
  }

  if (context.recording) {
    return {
      recording: context.recording,
      duration: Math.max(context.recording.duration, 1),
    };
  }

  return null;
};

const APPLY_REPLAY_STATE_ACTIONS = [
  "applyWorkspaceEventsAtTime",
  "applyRuntimeEventsAtTime",
  "applyFrameAtTime",
  "applyPreviewEventsAtTime",
  "applySlideEventsAtTime",
] as const;

const APPLY_REPLAY_STATE_AND_STORE_PAUSE_ACTIONS = [
  ...APPLY_REPLAY_STATE_ACTIONS,
  "storeRecordedFrameAtPause",
] as const;

const SYNC_PAUSED_WORKSPACE_ACTIONS = [
  "storeRecordedFrameAtPause",
  "adoptPlaybackWorkspaceAtPause",
  "detachPlaybackWorkspace",
] as const;

const APPLY_REPLAY_AFTER_EDITOR_SYNC_ACTIONS = [
  "setEditorRef",
  "clearPendingPlaybackEditorSync",
  "invalidateRenderedPlaybackState",
  ...APPLY_REPLAY_STATE_ACTIONS,
] as const;

const SET_EDITOR_REF_ACTIONS = ["setEditorRef", "invalidateRenderedPlaybackState"] as const;

const REATTACH_AND_APPLY_REPLAY_STATE_ACTIONS = [
  "reattachPlaybackWorkspace",
  ...APPLY_REPLAY_STATE_ACTIONS,
] as const;

const RESET_AND_REATTACH_REPLAY_STATE_ACTIONS = [
  "resetPlayback",
  ...REATTACH_AND_APPLY_REPLAY_STATE_ACTIONS,
] as const;

const MOUSE_FRAME_INTERVAL_MS = 50;
const CURSOR_EVENT_INTERVAL_MS = 8;

const didCursorPositionChange = (
  previous: MouseCursorPosition | undefined,
  next: MouseCursorPosition | undefined,
): boolean => {
  return !areMouseCursorPositionsEqual(previous, next);
};

const appendCursorEvent = (
  cursorEvents: CursorRecordingEvent[],
  timestamp: number,
  mousePosition: MouseCursorPosition | undefined,
): CursorRecordingEvent[] => {
  if (!mousePosition) return cursorEvents;

  const lastCursorEvent = cursorEvents[cursorEvents.length - 1];
  const visibilityChanged = lastCursorEvent?.visible !== mousePosition.visible;
  const cursorChanged = didCursorPositionChange(lastCursorEvent, mousePosition);
  const isCadenceDue =
    !lastCursorEvent || timestamp - lastCursorEvent.timestamp >= CURSOR_EVENT_INTERVAL_MS;

  if (!cursorChanged || (!visibilityChanged && !isCadenceDue)) {
    return cursorEvents;
  }

  return [...cursorEvents, { timestamp, ...mousePosition }];
};

const hasPlaybackAudio = (context: EditorMachineContext): boolean =>
  context.recording?.audioBlob instanceof Blob;

/**
 * Find the appropriate frame for a given timestamp (optimized)
 */

// ============================================================================
// Mouse Tracking Actor
// ============================================================================

interface MouseTrackingInput {
  onMouseMove: (pos: MouseCursorPosition) => void;
}

const mouseTrackingActor = fromCallback<{ type: "STOP" }, MouseTrackingInput>(({ input }) => {
  let forceRecordedCursorHidden = false;

  const handleMouseMove = (e: MouseEvent) => {
    input.onMouseMove(
      createCursorPositionFromClientPoint({
        clientX: e.clientX,
        clientY: e.clientY,
        visible: !forceRecordedCursorHidden,
        eventTarget: e.target,
      }),
    );
  };

  const handleMouseLeave = () => {
    input.onMouseMove({ x: 0, y: 0, visible: false });
  };

  const handleRecordedCursorVisibility = (event: Event) => {
    if (!(event instanceof CustomEvent) || !isRecordedCursorVisibilityDetail(event.detail)) {
      return;
    }

    forceRecordedCursorHidden = !event.detail.visible;
    input.onMouseMove(
      createCursorPositionFromClientPoint({
        clientX: event.detail.x,
        clientY: event.detail.y,
        visible: event.detail.visible,
        eventTarget:
          typeof document.elementFromPoint === "function"
            ? document.elementFromPoint(event.detail.x, event.detail.y)
            : null,
      }),
    );
  };

  // Handle iframe mouse tracking
  const iframeListeners = new Map<
    HTMLIFrameElement,
    { move: (e: MouseEvent) => void; leave: () => void }
  >();
  const iframeLoadHandlers = new Map<HTMLIFrameElement, () => void>();
  const iframeWindowMap = new Map<Window, HTMLIFrameElement>();
  const directlyTrackedIframes = new Set<HTMLIFrameElement>();

  const rememberIframeWindow = (iframe: HTMLIFrameElement) => {
    const iframeWindow = iframe.contentWindow;

    if (iframeWindow) {
      iframeWindowMap.set(iframeWindow, iframe);
    }
  };

  const forgetIframeWindow = (iframe: HTMLIFrameElement) => {
    const iframeWindow = iframe.contentWindow;

    if (!iframeWindow) {
      return;
    }

    const currentIframe = iframeWindowMap.get(iframeWindow);
    if (currentIframe === iframe) {
      iframeWindowMap.delete(iframeWindow);
    }
  };

  const setupIframeListeners = (iframe: HTMLIFrameElement) => {
    rememberIframeWindow(iframe);

    const onIframeMouseMove = (e: MouseEvent) => {
      const rect = iframe.getBoundingClientRect();
      input.onMouseMove(
        createCursorPositionFromClientPoint({
          clientX: rect.left + e.clientX,
          clientY: rect.top + e.clientY,
          visible: !forceRecordedCursorHidden,
          targetElement: iframe,
        }),
      );
    };

    const onIframeMouseLeave = () => {
      input.onMouseMove({ x: 0, y: 0, visible: false });
    };

    const attachToDocument = () => {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!iframeDoc) {
          directlyTrackedIframes.delete(iframe);
          return;
        }

        // Clean up existing listeners if any
        const existing = iframeListeners.get(iframe);
        if (existing) {
          iframeDoc.removeEventListener("mousemove", existing.move);
          iframeDoc.removeEventListener("mouseleave", existing.leave);
        }

        iframeDoc.addEventListener("mousemove", onIframeMouseMove, true);
        iframeDoc.addEventListener("mouseleave", onIframeMouseLeave, true);
        directlyTrackedIframes.add(iframe);

        iframeListeners.set(iframe, {
          move: onIframeMouseMove,
          leave: onIframeMouseLeave,
        });
      } catch (err) {
        // Likely cross-origin
        directlyTrackedIframes.delete(iframe);
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
    directlyTrackedIframes.delete(iframe);
    forgetIframeWindow(iframe);

    const handlers = iframeListeners.get(iframe);
    const loadHandler = iframeLoadHandlers.get(iframe);

    if (loadHandler) {
      iframe.removeEventListener("load", loadHandler);
      iframeLoadHandlers.delete(iframe);
    }

    if (handlers) {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
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

  const handleIframeInteractionMessage = (event: MessageEvent) => {
    const { type, payload } = event.data || {};
    if (type !== IFRAME_INTERACTION_MESSAGE_TYPE) {
      return;
    }

    if (payload?.type !== "mousemove") {
      return;
    }

    if (typeof payload?.data?.clientX !== "number" || typeof payload?.data?.clientY !== "number") {
      return;
    }

    const sourceWindow = event.source as Window | null;
    if (!sourceWindow) {
      return;
    }

    const iframe = iframeWindowMap.get(sourceWindow);
    if (!iframe || directlyTrackedIframes.has(iframe)) {
      return;
    }

    const rect = iframe.getBoundingClientRect();
    input.onMouseMove(
      createCursorPositionFromClientPoint({
        clientX: rect.left + payload.data.clientX,
        clientY: rect.top + payload.data.clientY,
        visible: !forceRecordedCursorHidden,
        targetElement: iframe,
      }),
    );
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
      } else if (mutation.type === "attributes" && mutation.target instanceof HTMLIFrameElement) {
        if (mutation.attributeName === "src" || mutation.attributeName === "srcdoc") {
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
  window.addEventListener(RECORDED_CURSOR_VISIBILITY_EVENT, handleRecordedCursorVisibility);
  window.addEventListener("message", handleIframeInteractionMessage);

  return () => {
    observer.disconnect();
    document.removeEventListener("mousemove", handleMouseMove, true);
    document.removeEventListener("mouseleave", handleMouseLeave, true);
    window.removeEventListener(RECORDED_CURSOR_VISIBILITY_EVENT, handleRecordedCursorVisibility);
    window.removeEventListener("message", handleIframeInteractionMessage);

    // Clean up load listeners
    iframeLoadHandlers.forEach((handler, iframe) => {
      iframe.removeEventListener("load", handler);
    });
    iframeLoadHandlers.clear();
    iframeWindowMap.clear();
    directlyTrackedIframes.clear();

    iframeListeners.forEach((handlers, iframe) => {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
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
});

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
          const exactDuration = await calculateDurationFromFileReader(audioBlob);
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
    initRecordingSession: assign(({ context }) => {
      const startedAt = Date.now();
      const slideEvents: SlideEvent[] = [];
      const previewEvents: PreviewEvent[] = [];
      const workspaceEvents: WorkspaceRecordingEvent[] = [];
      const runtimeEvents: RuntimeRecordingEvent[] = [];
      const initialMousePosition: MouseCursorPosition = { x: 0, y: 0, visible: false };

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
          slideEvents,
          previewEvents,
          workspaceEvents,
          runtimeEvents,
          cursorEvents: [{ timestamp: 0, ...initialMousePosition }],
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

      return {
        session: {
          ...session,
          frames: [initialFrame],
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
        const frames = context.session.frames;
        const lastFrame = frames[frames.length - 1];
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

      return {
        session: {
          ...context.session,
          frames: [...context.session.frames, frame],
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

      return {
        session: {
          ...context.session,
          frames: [...context.session.frames, frame],
        },
        currentFrame: frame,
      };
    }),

    finalizeRecording: assign(({ context }) => {
      if (!context.session) return { recording: null };

      // Base duration from session timing
      const duration = Math.max(Date.now() - context.session.startedAt, 1);
      const slides = context.getSlides?.();
      const currentWorkspaceSnapshot = context.getWorkspaceSnapshot?.() || undefined;
      const workspaceSnapshot = currentWorkspaceSnapshot
        ? toSidebarWidthDeltaSnapshot(currentWorkspaceSnapshot, 0)
        : undefined;
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
        workspaceEvents: context.session.workspaceEvents,
        runtimeEvents: context.session.runtimeEvents,
        cursorEvents: context.session.cursorEvents,
        slides: slides,
        duration,
        audioBlob: context.audio.blob || undefined,
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
        },
        timeline: {
          ...context.timeline,
          duration,
        },
        lastAppliedFrameIndex: -1,
        lastAppliedPreviewEventIndex: -1,
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
        lastAppliedSlideEventIndex: -1,
        lastAppliedWorkspaceEventIndex: initialWorkspaceEvent ? 0 : -1,
        lastAppliedRuntimeEventIndex: initialRuntimeEvent ? 0 : -1,
        lastAppliedPreviewState: undefined,
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
            target: "startingRecording",
            guard: ({ context }) => context.enableAudioRecording,
          },
          {
            target: "recording",
            actions: [
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
            audio: { ...context.audio, isRecording: true },
          });
        }),
      ],
      on: {
        STARTED: {
          target: "recording",
          actions: [
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
      exit: [stopChild("mouseTracker")],
      on: {
        CAPTURE_FRAME: {
          actions: ["captureFrame", "notifyFrame"],
        },
        STOPPED: {
          actions: "storeAudioBlob",
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
            guard: ({ context }) => context.enableAudioRecording && context.audio.isRecording,
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
        enqueueActions(({ enqueue }) => {
          enqueue.sendTo("audioRecorder", { type: "STOP" });
        }),
      ],
      exit: [stopChild("audioRecorder")],
      on: {
        STOPPED: {
          target: "loading",
          actions: ["storeAudioBlob", "finalizeRecording", "notifyRecordingStop"],
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

          const audioBlob = context.recording?.audioBlob;
          if (audioBlob instanceof Blob) {
            enqueue.spawnChild("audioPlayback", {
              id: "audioPlayer",
              input: {
                blob: audioBlob,
                volume: context.timeline.volume,
                playbackRate: context.timeline.speed,
                startPositionMs: context.timeline.currentTime,
              },
            });
          }
        }),
      ],
      exit: [stopChild("timelineActor"), stopChild("audioPlayer"), "clearCursorDecorations"],
      on: {
        WORKSPACE_EVENT: {
          actions: ["detachPlaybackWorkspace"],
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
              if (hasPlaybackAudio(context) && now - lastSync > 250) {
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
              if (hasPlaybackAudio(context)) {
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
              if (hasPlaybackAudio(context)) {
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
            ...RESET_AND_REATTACH_REPLAY_STATE_ACTIONS,
            "notifyPlaybackUpdate",
            enqueueActions(({ context, enqueue }) => {
              enqueue.sendTo("timelineActor", { type: "SEEK", time: 0 });
              if (hasPlaybackAudio(context)) {
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
              enqueue.sendTo("timelineActor", {
                type: "SEEK",
                time: context.timeline.currentTime,
              });
              if (hasPlaybackAudio(context)) {
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
              if (hasPlaybackAudio(context)) {
                enqueue.sendTo("audioPlayer", { type: "PLAY" });
              }
            }),
            "notifyPlaybackStart",
            "notifyPlaybackUpdate",
          ],
          exit: enqueueActions(({ context, enqueue }) => {
            enqueue.sendTo("timelineActor", { type: "PAUSE" });
            if (hasPlaybackAudio(context)) {
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
                  if (hasPlaybackAudio(context)) {
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
                    if (hasPlaybackAudio(context)) {
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
