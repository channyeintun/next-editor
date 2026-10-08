import type {
  PreviewDomPatchBatch,
  PreviewEvent,
  PreviewInitialDocument,
  Slide,
  SlideEvent,
} from "../slides";
import type {
  CursorRecordingEvent,
  Recording,
  RecordingChapter,
  RecordingAudioSource,
  RecordingCameraSource,
  RecordingTrackMeta,
} from "../types";
import type { WhiteboardEvent } from "../whiteboard";
import type { RuntimeRecordingEvent, RuntimeRecordingSnapshot } from "../../../types/runtime";
import type { WorkspaceRecordingEvent, WorkspaceRecordingSnapshot } from "../../../types/workspace";
import type { ChatRecordingEvent } from "../../../types/chat";
import { DELTA_CONFIG, type DeltaFrame } from "../utils/deltaTypes";
import { buildRecordingClusters } from "../utils/recordingClusters";
import type { MediaSpan } from "../utils/mediaSpans";

// ============================================================================
// Turning a take's tracks into a Recording.
//
// Stopping a take does this with the live session; recovering a take a closed
// tab left behind does it with the tracks its draft journal kept. Both go
// through `assembleRecording`, so a recovered take is the recording the take
// would have become.
// ============================================================================

/**
 * A take's capture tracks: the session's append-only arrays. RecordingSession declares
 * its tracks only through this interface, so a retake's cut and the draft journal,
 * which both go by it, cover every track.
 */
export interface RecordingTracks {
  /**
   * Already-compressed frames built incrementally during capture. Append-only, except
   * that a retake replaces it (and every other track) with a copy cut back to the
   * safe point.
   */
  frames: DeltaFrame[];
  /** Collected slide events during recording */
  slideEvents: SlideEvent[];
  /** Collected preview events during recording */
  previewEvents: PreviewEvent[];
  /** Collected initial preview documents during recording */
  previewInitialDocuments: PreviewInitialDocument[];
  /** Collected preview DOM patch batches during recording */
  previewPatchBatches: PreviewDomPatchBatch[];
  /** Collected workspace events during recording */
  workspaceEvents: WorkspaceRecordingEvent[];
  /** Collected runtime events during recording (checkpoints + terminal-output deltas) */
  runtimeEvents: RuntimeRecordingEvent[];
  /** High-cadence fake cursor samples during recording */
  cursorEvents: CursorRecordingEvent[];
  /** Collected whiteboard change events during recording */
  whiteboardEvents: WhiteboardEvent[];
  /** Collected coding-agent chat deltas + sparse checkpoints during recording */
  chatEvents: ChatRecordingEvent[];
}

export type RecordingTrackName = keyof RecordingTracks;

export const createEmptyRecordingTracks = (): RecordingTracks => ({
  frames: [],
  slideEvents: [],
  previewEvents: [],
  previewInitialDocuments: [],
  previewPatchBatches: [],
  workspaceEvents: [],
  runtimeEvents: [],
  cursorEvents: [],
  whiteboardEvents: [],
  chatEvents: [],
});

/**
 * Every track, in the order the draft journal writes them.
 *
 * Read off the empty tracks rather than kept by hand: the typecheck holds that
 * literal to name every track, while a hand-kept list with a track left out
 * still compiles, and the journal then drops that track with no error.
 */
export const RECORDING_TRACK_NAMES = Object.keys(
  createEmptyRecordingTracks(),
) as readonly RecordingTrackName[];

interface RecordingMediaInput<Source> {
  blob?: Blob;
  source?: Source;
  mimeType?: string;
  startOffsetMs: number;
}

export interface AssembleRecordingInput {
  tracks: RecordingTracks;
  duration: number;
  slides?: Slide[];
  workspaceSnapshot?: WorkspaceRecordingSnapshot;
  runtimeSnapshot?: RuntimeRecordingSnapshot;
  audio: RecordingMediaInput<RecordingAudioSource> & {
    /**
     * The narration is still on its way: a microphone blob can land after the take is
     * finalized (attachLateAudioBlob splices it in), so the tracks list audio already.
     */
    pending?: boolean;
  };
  camera: RecordingMediaInput<RecordingCameraSource>;
  /**
   * What retakes discarded from the recorders' files (media time). Cut from recorded
   * narration when the take loads, and mapped around in the camera video.
   */
  mediaCuts?: readonly MediaSpan[];
  chapters?: readonly RecordingChapter[];
}

const EDITOR_TRACK_ID = "editor";
const SLIDE_TRACK_ID = "slide";
const PREVIEW_TRACK_ID = "preview";
const WORKSPACE_TRACK_ID = "workspace";
const RUNTIME_TRACK_ID = "runtime";
const CURSOR_TRACK_ID = "cursor";
const WHITEBOARD_TRACK_ID = "whiteboard";
const CHAT_TRACK_ID = "chat";
const AUDIO_TRACK_ID = "audio";
const CAMERA_TRACK_ID = "camera";

const buildTrackMetadata = ({
  durationMs,
  hasSlideEvents,
  hasPreviewEvents,
  hasWorkspaceEvents,
  hasRuntimeEvents,
  hasCursorEvents,
  hasWhiteboardEvents,
  hasChatEvents,
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
  hasWhiteboardEvents: boolean;
  hasChatEvents: boolean;
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
  if (hasWhiteboardEvents) {
    tracks.push({ id: WHITEBOARD_TRACK_ID, kind: "whiteboard", durationMs });
  }
  if (hasChatEvents) {
    tracks.push({ id: CHAT_TRACK_ID, kind: "chat", durationMs });
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

export function assembleRecording({
  tracks,
  duration,
  slides,
  workspaceSnapshot,
  runtimeSnapshot,
  audio,
  camera,
  mediaCuts = [],
  chapters = [],
}: AssembleRecordingInput): Recording {
  // Frames were compressed incrementally during capture.
  const clusters = buildRecordingClusters(tracks.frames, duration);
  const trackMetadata = buildTrackMetadata({
    durationMs: duration,
    hasSlideEvents: tracks.slideEvents.length > 0,
    hasPreviewEvents:
      tracks.previewEvents.length > 0 ||
      tracks.previewInitialDocuments.length > 0 ||
      tracks.previewPatchBatches.length > 0,
    hasWorkspaceEvents: tracks.workspaceEvents.length > 0,
    hasRuntimeEvents: tracks.runtimeEvents.length > 0,
    hasCursorEvents: tracks.cursorEvents.length > 0,
    hasWhiteboardEvents: tracks.whiteboardEvents.length > 0,
    hasChatEvents: tracks.chatEvents.length > 0,
    audioMimeType: audio.mimeType || audio.blob?.type,
    audioSource: audio.source,
    audioStartOffsetMs: audio.startOffsetMs,
    hasAudio: Boolean(audio.blob) || Boolean(audio.pending),
    cameraMimeType: camera.mimeType || camera.blob?.type,
    cameraSource: camera.source,
    cameraStartOffsetMs: camera.startOffsetMs,
    hasCamera: Boolean(camera.blob),
  });

  return {
    version: DELTA_CONFIG.VERSION,
    id: Date.now().toString(),
    name: `Recording ${Date.now()}`,
    createdAt: Date.now(),
    frames: tracks.frames,
    keyframeInterval: DELTA_CONFIG.KEYFRAME_INTERVAL,
    slideEvents: tracks.slideEvents,
    previewEvents: tracks.previewEvents,
    previewInitialDocuments: tracks.previewInitialDocuments,
    previewPatchBatches: tracks.previewPatchBatches,
    workspaceEvents: tracks.workspaceEvents,
    runtimeEvents: tracks.runtimeEvents,
    cursorEvents: tracks.cursorEvents,
    whiteboardEvents: tracks.whiteboardEvents,
    chatEvents: tracks.chatEvents,
    slides,
    chapters: chapters.length > 0 ? [...chapters] : undefined,
    tracks: trackMetadata,
    clusters: clusters.length > 0 ? clusters : undefined,
    duration,
    audioBlob: audio.blob,
    audioSource: audio.source,
    audioStartOffsetMs: audio.blob ? audio.startOffsetMs : undefined,
    cameraBlob: camera.blob,
    cameraSource: camera.source,
    cameraStartOffsetMs: camera.blob ? camera.startOffsetMs : undefined,
    // A selected narration file is an input played in step with the take, so a retake
    // rewinds it instead of recording over it: only a microphone take is cut.
    pendingAudioEdit:
      mediaCuts.length > 0 && audio.source === "microphone" ? { cuts: [...mediaCuts] } : undefined,
    cameraCuts: mediaCuts.length > 0 && camera.blob ? [...mediaCuts] : undefined,
    streamFinalized: true,
    workspaceSnapshot,
    runtimeSnapshot,
  };
}
