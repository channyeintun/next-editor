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
  RecordingAudioSource,
  RecordingCameraSource,
} from "../types";
import type { WhiteboardEvent } from "../whiteboard";
import type { RuntimeRecordingEvent, RuntimeRecordingSnapshot } from "../../../types/runtime";
import type { WorkspaceRecordingEvent, WorkspaceRecordingSnapshot } from "../../../types/workspace";
import type { ChatRecordingEvent } from "../../../types/chat";
import { DELTA_CONFIG, type DeltaFrame } from "../utils/deltaTypes";
import { buildRecordingClusters } from "../utils/recordingClusters";
import { buildTrackMetadata } from "./editorMachineHelpers";

// ============================================================================
// Turning a take's tracks into a Recording.
//
// Stopping a take does this with the live session; recovering a take a closed
// tab left behind does it with the tracks its draft journal kept. Both go
// through `assembleRecording`, so a recovered take is the recording the take
// would have become.
// ============================================================================

/** A take's capture tracks: the session's append-only arrays. */
export interface RecordingTracks {
  frames: DeltaFrame[];
  slideEvents: SlideEvent[];
  previewEvents: PreviewEvent[];
  previewInitialDocuments: PreviewInitialDocument[];
  previewPatchBatches: PreviewDomPatchBatch[];
  workspaceEvents: WorkspaceRecordingEvent[];
  runtimeEvents: RuntimeRecordingEvent[];
  cursorEvents: CursorRecordingEvent[];
  whiteboardEvents: WhiteboardEvent[];
  chatEvents: ChatRecordingEvent[];
}

export type RecordingTrackName = keyof RecordingTracks;

export const RECORDING_TRACK_NAMES = [
  "frames",
  "slideEvents",
  "previewEvents",
  "previewInitialDocuments",
  "previewPatchBatches",
  "workspaceEvents",
  "runtimeEvents",
  "cursorEvents",
  "whiteboardEvents",
  "chatEvents",
] as const satisfies readonly RecordingTrackName[];

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
}

export function assembleRecording({
  tracks,
  duration,
  slides,
  workspaceSnapshot,
  runtimeSnapshot,
  audio,
  camera,
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
    tracks: trackMetadata,
    clusters: clusters.length > 0 ? clusters : undefined,
    duration,
    audioBlob: audio.blob,
    audioSource: audio.source,
    audioStartOffsetMs: audio.blob ? audio.startOffsetMs : undefined,
    cameraBlob: camera.blob,
    cameraSource: camera.source,
    cameraStartOffsetMs: camera.blob ? camera.startOffsetMs : undefined,
    streamFinalized: true,
    workspaceSnapshot,
    runtimeSnapshot,
  };
}
