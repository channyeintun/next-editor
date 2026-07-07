import type * as monaco from "monaco-editor";
import type {
  CursorRecordingEvent,
  EditorFrame,
  EditorPosition,
  EditorSelection,
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
  arePositionsEqual,
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
import type { AudioPlaybackEvent, AudioPlaybackInput } from "./audioActor";

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

/** Content string plus the model identity it was read at, for reuse across captures. */
export interface CapturedContentRef {
  value: string;
  versionId: number;
  /** `model.uri.toString()` — version ids are per-model counters, so identity requires both. */
  modelUri: string;
}

/**
 * `saveViewState()` result plus the cheap scalars that fully determine whether
 * it would come out identical if recomputed, for reuse across captures.
 */
export interface CapturedViewStateRef {
  value: monaco.editor.ICodeEditorViewState | null;
  versionId: number;
  modelUri: string;
  scrollTop: number;
  scrollLeft: number;
  selection: EditorSelection;
  position: EditorPosition;
}

/**
 * Create a frame from current editor state.
 *
 * `previousContent`, when both its `versionId` and `modelUri` match the current
 * model, lets the frame reuse the prior content string by reference instead of
 * calling `editor.getValue()` again. This matters for mouse/selection frames (no
 * document edit since the last capture): the caller's content-delta diff already
 * short-circuits on `prev === next` by reference, so avoiding a fresh `getValue()`
 * copy turns that into an O(1) check instead of an O(doc) string equality scan
 * preceded by an O(doc) copy.
 *
 * The `modelUri` check matters because this is a multi-file workspace — Monaco's
 * `getVersionId()` is a per-model counter, so switching the active file between
 * captures can coincidentally produce the same numeric version id on the new
 * model. Without also checking the model URI, that coincidence would silently
 * reuse the previous file's content string for the new file, desyncing the
 * recorded stream.
 *
 * `previousViewState` similarly lets the frame reuse the prior `viewState`
 * object by reference, skipping `editor.saveViewState()` and the normalize pass
 * over it, whenever the values that `saveViewState()` would derive from —
 * content version, model, scroll position, selection, and cursor position — are
 * all unchanged since the last capture. This is the case for mouse-move-only
 * frames (`onDidScrollChange`/pointer frames with no edit, no scroll, no
 * selection change): `saveViewState()` would return a structurally identical
 * (but freshly allocated) object, and the delta encoder's `areStructuredDataEqual`
 * deep-compare on `viewState` (see `frameDelta.ts`) already short-circuits on
 * reference equality, so reusing the reference turns that deep compare into an
 * O(1) check. Selection/position changes still invalidate the reuse — they are
 * part of the gate, not bypassed by it — so cursor/selection-only frames still
 * get a freshly saved (and correctly differing) viewState.
 */
export const createFrame = (
  editor: monaco.editor.IStandaloneCodeEditor,
  timestamp: number,
  mouseCursor: MouseCursorPosition,
  getSlideState?: EditorMachineInput["getSlideState"],
  getPreviewState?: EditorMachineInput["getPreviewState"],
  previousContent?: CapturedContentRef,
  previousViewState?: CapturedViewStateRef,
): {
  frame: EditorFrame;
  contentVersionId: number;
  modelUri: string;
  viewStateRef: CapturedViewStateRef;
} => {
  const model = editor.getModel();
  const versionId = model?.getVersionId() ?? -1;
  const modelUri = model?.uri.toString() ?? "";
  const content =
    previousContent &&
    previousContent.versionId === versionId &&
    previousContent.modelUri === modelUri
      ? previousContent.value
      : editor.getValue();
  const position = normalizeEditorPosition(editor.getPosition());
  const selection = normalizeEditorSelection(editor.getSelection(), undefined, position);
  const scrollTop = editor.getScrollTop();
  const scrollLeft = editor.getScrollLeft();

  const canReuseViewState =
    previousViewState !== undefined &&
    previousViewState.versionId === versionId &&
    previousViewState.modelUri === modelUri &&
    previousViewState.scrollTop === scrollTop &&
    previousViewState.scrollLeft === scrollLeft &&
    arePositionsEqual(previousViewState.position, position) &&
    areSelectionsEqual(previousViewState.selection, selection);

  const viewState = canReuseViewState
    ? previousViewState.value
    : normalizeEditorViewState(editor.saveViewState(), selection, position);

  const slideState = getSlideState?.();
  const previewState = getPreviewState?.();

  return {
    frame: {
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
    },
    contentVersionId: versionId,
    modelUri,
    viewStateRef: {
      value: viewState,
      versionId,
      modelUri,
      scrollTop,
      scrollLeft,
      selection,
      position,
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

/**
 * Tolerance for treating the playhead as "at the end" — timeline ticks and audio
 * durations can disagree by a few milliseconds, so end-of-playback checks compare
 * against `duration - PLAYBACK_END_EPSILON_MS` rather than the exact duration.
 */
export const PLAYBACK_END_EPSILON_MS = 100;

const didCursorPositionChange = (
  previous: MouseCursorPosition | undefined,
  next: MouseCursorPosition | undefined,
): boolean => {
  return !areMouseCursorPositionsEqual(previous, next);
};

/**
 * Pushes in place — `cursorEvents` keeps its identity for the whole session (see the
 * mutable capture buffer invariant on {@link RecordingSession}). Returns `false` when
 * the position deduplicates against the last event (no push happened) so callers know
 * whether to bump `sessionRevision`.
 */
export const appendCursorEvent = (
  cursorEvents: CursorRecordingEvent[],
  timestamp: number,
  mousePosition: MouseCursorPosition | undefined,
): boolean => {
  if (!mousePosition) return false;

  const lastCursorEvent = cursorEvents[cursorEvents.length - 1];
  const cursorChanged = didCursorPositionChange(lastCursorEvent, mousePosition);

  if (!cursorChanged) {
    return false;
  }

  cursorEvents.push({ timestamp, ...mousePosition });
  return true;
};

interface PlaybackAudioState {
  audioUrl: string;
  loadedUntilMs: number;
  startOffsetMs: number;
  finalized: boolean;
}

export const getPlaybackAudioState = (recording: Recording | null): PlaybackAudioState | null => {
  if (!recording) {
    return null;
  }

  const audioBlob = recording.audioBlob;
  if (!(audioBlob instanceof Blob) || audioBlob.size === 0) {
    return null;
  }

  const audioUrl = recording.audioUrl;
  if (!audioUrl) {
    return null;
  }

  const startOffsetMs = recording.audioStartOffsetMs ?? 0;

  return {
    audioUrl,
    loadedUntilMs: recording.duration,
    startOffsetMs,
    finalized: recording.streamFinalized ?? true,
  };
};

export const hasPlaybackAudio = (context: EditorMachineContext): boolean =>
  getPlaybackAudioState(context.recording) !== null;

export const hasSpawnedPlaybackAudio = (context: EditorMachineContext): boolean =>
  context.playbackAudioSpawned;

export const shouldRecordCamera = (context: EditorMachineContext): boolean =>
  context.enableCameraRecording && context.camera.isRecording;

/**
 * The subset of xstate's `enqueue` object used to drive the "audioPlayer" child actor.
 * Kept structural (rather than importing xstate's generic `ActionEnqueuer`) so this
 * helper doesn't need to thread the machine's full setup() type parameters.
 */
export interface PlaybackAudioEnqueue {
  spawnChild: (
    src: "audioPlayback",
    options: { id: "audioPlayer"; input: AudioPlaybackInput },
  ) => void;
  sendTo: (actor: "audioPlayer", event: AudioPlaybackEvent) => void;
  assign: (updater: Partial<EditorMachineContext>) => void;
}

export interface SyncPlaybackAudioOptions {
  /** Spawn a fresh "audioPlayer" child if this recording has audio and none exists yet. */
  spawnIfMissing: boolean;
  /** Send SEEK to the current timeline position. */
  seek: boolean;
  /** Send SET_PLAYBACK_RATE to match the timeline speed. */
  syncRate: boolean;
  /** Send SET_VOLUME to match the timeline volume. */
  syncVolume: boolean;
  /** Send PLAY. */
  play: boolean;
}

/**
 * The one true spawn/append/seek/rate/volume/play sequence for the playback "audioPlayer"
 * child actor, encoding what used to be duplicated (with drifting variations) across
 * playback entry, EXTEND_RECORDING, and the "playing" entry in editorMachine.ts.
 *
 * Returns whether the audio actor is spawned and being controlled by this call, so
 * callers that need to interleave other actor messages (e.g. the timelineActor) around
 * the audio sequence can reuse that without recomputing it.
 */
export const syncPlaybackAudio = (
  context: EditorMachineContext,
  enqueue: PlaybackAudioEnqueue,
  options: SyncPlaybackAudioOptions,
): boolean => {
  const audioState = getPlaybackAudioState(context.recording);
  if (!audioState) {
    return false;
  }

  const spawning = options.spawnIfMissing && !context.playbackAudioSpawned;
  const controlling = spawning || context.playbackAudioSpawned;
  if (!controlling) {
    return false;
  }

  if (spawning) {
    enqueue.spawnChild("audioPlayback", {
      id: "audioPlayer",
      input: {
        audioUrl: audioState.audioUrl,
        startOffsetMs: audioState.startOffsetMs,
        volume: context.timeline.volume,
        playbackRate: context.timeline.speed,
        startPositionMs: context.timeline.currentTime,
      },
    });
    enqueue.assign({ playbackAudioSpawned: true });
  }

  if (options.seek) {
    enqueue.sendTo("audioPlayer", { type: "SEEK", timeMs: context.timeline.currentTime });
  }
  if (options.syncRate) {
    enqueue.sendTo("audioPlayer", { type: "SET_PLAYBACK_RATE", rate: context.timeline.speed });
  }
  if (options.syncVolume) {
    enqueue.sendTo("audioPlayer", { type: "SET_VOLUME", volume: context.timeline.volume });
  }
  if (options.play) {
    enqueue.sendTo("audioPlayer", { type: "PLAY" });
  }

  return true;
};
