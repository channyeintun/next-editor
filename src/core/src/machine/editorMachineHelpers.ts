import type * as monaco from "monaco-editor";
import type {
  CursorRecordingEvent,
  EditorFrame,
  MouseCursorPosition,
  Recording,
  RecordingClusterMeta,
  RecordingMediaFragment,
  RecordingTrackMeta,
} from "../types";
import type {
  EditorMachineContext,
  EditorMachineEvent,
  EditorMachineInput,
  RecordingSessionMediaFragment,
} from "./types";
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
} from "../utils/editorState";
import { isEditorReady } from "../utils/validation";
import { areStructuredDataEqual } from "../../../utils/equality";
import { areMouseCursorPositionsEqual } from "../utils/cursorCoordinates";
import { isKeyframe } from "../utils/frameDelta";

// ============================================================================
// Editor machine helpers
//
// Pure(ish) building blocks for `editorMachine.ts`: recording metadata derivation
// (tracks/clusters/media fragments), editor frame capture/apply, playback-audio
// state inspection, and the named action lists reused across machine transitions.
// Kept out of the machine file so the machine reads as state/transition wiring.
// ============================================================================

const EDITOR_TRACK_ID = "editor";
const SLIDE_TRACK_ID = "slide";
const PREVIEW_TRACK_ID = "preview";
const WORKSPACE_TRACK_ID = "workspace";
const RUNTIME_TRACK_ID = "runtime";
const CURSOR_TRACK_ID = "cursor";
export const AUDIO_TRACK_ID = "audio";
export const CAMERA_TRACK_ID = "camera";

export const buildRecordingClusters = (
  frames: Recording["frames"],
  durationMs: number,
): RecordingClusterMeta[] => {
  if (frames.length === 0) {
    return durationMs > 0
      ? [{ index: 0, startTimeMs: 0, endTimeMs: durationMs, containsKeyframe: false }]
      : [];
  }

  const clusters: RecordingClusterMeta[] = [];
  let startIndex = 0;

  while (startIndex < frames.length) {
    let endIndex = startIndex + 1;
    while (endIndex < frames.length && !isKeyframe(frames[endIndex])) {
      endIndex += 1;
    }

    const startTimeMs = frames[startIndex]?.timestamp ?? 0;
    const nextStartTimeMs = endIndex < frames.length ? frames[endIndex].timestamp : durationMs;
    const lastFrameTimeMs = frames[endIndex - 1]?.timestamp ?? startTimeMs;

    clusters.push({
      index: clusters.length,
      startTimeMs,
      endTimeMs: Math.max(startTimeMs, nextStartTimeMs, lastFrameTimeMs),
      containsKeyframe: isKeyframe(frames[startIndex]),
    });

    startIndex = endIndex;
  }

  const lastCluster = clusters[clusters.length - 1];
  if (lastCluster) {
    lastCluster.endTimeMs = Math.max(lastCluster.startTimeMs, lastCluster.endTimeMs, durationMs);
  }

  return clusters;
};

const resolveClusterIndex = (
  clusters: ReadonlyArray<RecordingClusterMeta>,
  timeMs: number,
): number => {
  if (clusters.length === 0) {
    return 0;
  }

  for (let index = clusters.length - 1; index >= 0; index -= 1) {
    if (timeMs >= clusters[index].startTimeMs) {
      return clusters[index].index;
    }
  }

  return clusters[0].index;
};

export const buildTrackMetadata = ({
  durationMs,
  hasSlideEvents,
  hasPreviewEvents,
  hasWorkspaceEvents,
  hasRuntimeEvents,
  hasCursorEvents,
  audioMimeType,
  audioSource,
  audioStartOffsetMs,
  hasAudio,
  cameraMimeType,
  cameraSource,
  cameraStartOffsetMs,
  hasCamera,
}: {
  durationMs: number;
  hasSlideEvents: boolean;
  hasPreviewEvents: boolean;
  hasWorkspaceEvents: boolean;
  hasRuntimeEvents: boolean;
  hasCursorEvents: boolean;
  audioMimeType?: string;
  audioSource?: Recording["audioSource"];
  audioStartOffsetMs: number;
  hasAudio: boolean;
  cameraMimeType?: string;
  cameraSource?: Recording["cameraSource"];
  cameraStartOffsetMs: number;
  hasCamera: boolean;
}): RecordingTrackMeta[] => {
  const tracks: RecordingTrackMeta[] = [
    {
      id: EDITOR_TRACK_ID,
      kind: "editor",
      durationMs,
    },
  ];

  if (hasSlideEvents) {
    tracks.push({ id: SLIDE_TRACK_ID, kind: "slide", durationMs });
  }
  if (hasPreviewEvents) {
    tracks.push({ id: PREVIEW_TRACK_ID, kind: "preview", durationMs });
  }
  if (hasWorkspaceEvents) {
    tracks.push({ id: WORKSPACE_TRACK_ID, kind: "workspace", durationMs });
  }
  if (hasRuntimeEvents) {
    tracks.push({ id: RUNTIME_TRACK_ID, kind: "runtime", durationMs });
  }
  if (hasCursorEvents) {
    tracks.push({ id: CURSOR_TRACK_ID, kind: "cursor", durationMs });
  }
  if (hasAudio) {
    tracks.push({
      id: AUDIO_TRACK_ID,
      kind: "audio",
      mimeType: audioMimeType || undefined,
      source: audioSource,
      startOffsetMs: audioStartOffsetMs,
      durationMs: Math.max(0, durationMs - audioStartOffsetMs),
    });
  }
  if (hasCamera) {
    tracks.push({
      id: CAMERA_TRACK_ID,
      kind: "camera",
      mimeType: cameraMimeType || undefined,
      source: cameraSource,
      startOffsetMs: cameraStartOffsetMs,
      durationMs: Math.max(0, durationMs - cameraStartOffsetMs),
    });
  }

  return tracks;
};

export const buildMediaFragmentMetadata = (
  fragments: ReadonlyArray<RecordingSessionMediaFragment>,
  clusters: ReadonlyArray<RecordingClusterMeta>,
  finalEndTimeMs?: number,
): RecordingMediaFragment[] =>
  fragments.map((fragment, index) => ({
    trackId: fragment.trackId,
    clusterIndex: resolveClusterIndex(clusters, fragment.startTimeMs),
    startTimeMs: fragment.startTimeMs,
    endTimeMs: Math.max(
      fragment.startTimeMs,
      typeof finalEndTimeMs === "number" ? finalEndTimeMs : fragment.endTimeMs,
    ),
    byteLength: fragment.blob.size,
    isInit: index === 0,
  }));

/**
 * Apply editor state from a frame
 */
export const applyFrameState = (
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
          newDecorations.push({
            // Plain IRange (not `new Range(...)`) so this core machine never
            // value-imports monaco-editor; Monaco's decoration API lifts IRange
            // internally. Keeps the 3.7 MB editor chunk out of the eager route
            // graph (it loads lazily with CodeEditor instead).
            range: {
              startLineNumber: selection.positionLineNumber,
              startColumn: selection.positionColumn,
              endLineNumber: selection.positionLineNumber,
              endColumn: selection.positionColumn,
            },
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
export const createFrame = (
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

export const getLoadedRecordingPayload = (
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

export const APPLY_REPLAY_STATE_ACTIONS = [
  "applyWorkspaceEventsAtTime",
  "applyRuntimeEventsAtTime",
  "applyFrameAtTime",
  "applyPreviewPatchBatchesAtTime",
  "applyPreviewEventsAtTime",
  "applySlideEventsAtTime",
] as const;

export const APPLY_REPLAY_STATE_AND_STORE_PAUSE_ACTIONS = [
  ...APPLY_REPLAY_STATE_ACTIONS,
  "storeRecordedFrameAtPause",
] as const;

export const SYNC_PAUSED_WORKSPACE_ACTIONS = [
  "storeRecordedFrameAtPause",
  "adoptPlaybackWorkspaceAtPause",
  "detachPlaybackWorkspace",
] as const;

export const APPLY_REPLAY_AFTER_EDITOR_SYNC_ACTIONS = [
  "setEditorRef",
  "clearPendingPlaybackEditorSync",
  "invalidateRenderedPlaybackState",
  ...APPLY_REPLAY_STATE_ACTIONS,
] as const;

export const SET_EDITOR_REF_ACTIONS = ["setEditorRef", "invalidateRenderedPlaybackState"] as const;

const REATTACH_AND_APPLY_REPLAY_STATE_ACTIONS = [
  "reattachPlaybackWorkspace",
  ...APPLY_REPLAY_STATE_ACTIONS,
] as const;

export const RESET_AND_REATTACH_REPLAY_STATE_ACTIONS = [
  "resetPlayback",
  ...REATTACH_AND_APPLY_REPLAY_STATE_ACTIONS,
] as const;

export const MOUSE_FRAME_INTERVAL_MS = 50;

const didCursorPositionChange = (
  previous: MouseCursorPosition | undefined,
  next: MouseCursorPosition | undefined,
): boolean => {
  return !areMouseCursorPositionsEqual(previous, next);
};

export const appendCursorEvent = (
  cursorEvents: CursorRecordingEvent[],
  timestamp: number,
  mousePosition: MouseCursorPosition | undefined,
): CursorRecordingEvent[] => {
  if (!mousePosition) return cursorEvents;

  const lastCursorEvent = cursorEvents[cursorEvents.length - 1];
  const cursorChanged = didCursorPositionChange(lastCursorEvent, mousePosition);

  if (!cursorChanged) {
    return cursorEvents;
  }

  return [...cursorEvents, { timestamp, ...mousePosition }];
};

interface PlaybackAudioState {
  blob: Blob;
  loadedUntilMs: number;
  startOffsetMs: number;
  finalized: boolean;
  streamMode: boolean;
}

export const getPlaybackAudioState = (recording: Recording | null): PlaybackAudioState | null => {
  if (!recording) {
    return null;
  }

  const audioBlob = recording.audioBlob;
  if (!(audioBlob instanceof Blob) || audioBlob.size === 0) {
    return null;
  }

  const audioTrackId =
    recording.tracks?.find((track) => track.kind === "audio")?.id ??
    (recording.mediaFragments?.some((fragment) => fragment.trackId === "audio") ? "audio" : null);
  const startOffsetMs = recording.audioStartOffsetMs ?? 0;
  const streamFinalized = recording.streamFinalized ?? true;
  const audioTrack = recording.tracks?.find((track) => track.id === audioTrackId);
  const audioTrackEndTimeMs =
    audioTrack && typeof audioTrack.durationMs === "number"
      ? (audioTrack.startOffsetMs ?? startOffsetMs) + audioTrack.durationMs
      : recording.duration;

  if (streamFinalized || !audioTrackId || !recording.mediaFragments?.length) {
    return {
      blob: audioBlob,
      loadedUntilMs: recording.duration,
      startOffsetMs,
      finalized: streamFinalized,
      streamMode: false,
    };
  }

  const latestAudioEndTime = recording.mediaFragments.reduce((latest, fragment) => {
    if (fragment.trackId !== audioTrackId) {
      return latest;
    }
    const endTimeMs =
      fragment.endTimeMs > fragment.startTimeMs
        ? fragment.endTimeMs
        : recording.audioSource === "external" && (fragment.byteLength ?? 0) > 0
          ? Math.max(fragment.startTimeMs, audioTrackEndTimeMs, recording.duration)
          : fragment.endTimeMs;

    return Math.max(latest, endTimeMs);
  }, -1);

  if (latestAudioEndTime < 0) {
    return {
      blob: audioBlob,
      loadedUntilMs: recording.duration,
      startOffsetMs,
      finalized: true,
      streamMode: false,
    };
  }

  return {
    blob: audioBlob,
    loadedUntilMs: latestAudioEndTime,
    startOffsetMs,
    finalized: streamFinalized,
    streamMode: true,
  };
};

export const hasPlaybackAudio = (context: EditorMachineContext): boolean =>
  getPlaybackAudioState(context.recording) !== null;

export const hasSpawnedPlaybackAudio = (context: EditorMachineContext): boolean =>
  context.playbackAudioSpawned;

export const shouldRecordCamera = (context: EditorMachineContext): boolean =>
  context.enableCameraRecording && context.camera.isRecording;
