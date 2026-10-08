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
  RecordingTrackKind,
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

/**
 * The event tracks, in the order the track list names them, each with the arrays
 * that hold its events. A track is listed when any of its arrays has entries.
 */
const EVENT_TRACKS: ReadonlyArray<readonly [RecordingTrackKind, readonly RecordingTrackName[]]> = [
  ["slide", ["slideEvents"]],
  ["preview", ["previewEvents", "previewInitialDocuments", "previewPatchBatches"]],
  ["workspace", ["workspaceEvents"]],
  ["runtime", ["runtimeEvents"]],
  ["cursor", ["cursorEvents"]],
  ["whiteboard", ["whiteboardEvents"]],
  ["chat", ["chatEvents"]],
];

/**
 * The track list up to the media tracks: the editor track, then each event track that
 * has events. Capture builds it here, and so does the codec for a recording that carries
 * no track list, so a new event track is one row of EVENT_TRACKS for both.
 */
export function buildEventTrackMetadata(
  tracks: Partial<Record<RecordingTrackName, readonly unknown[]>>,
  durationMs: number,
): RecordingTrackMeta[] {
  const metadata: RecordingTrackMeta[] = [{ id: "editor", kind: "editor", durationMs }];
  for (const [kind, names] of EVENT_TRACKS) {
    if (names.some((name) => tracks[name]?.length)) {
      metadata.push({ id: kind, kind, durationMs });
    }
  }
  return metadata;
}

/**
 * The track list's entry for the narration or the camera video, which starts
 * `startOffsetMs` into the take. Whether the recording has one is the caller's rule.
 */
export function buildMediaTrackMetadata(
  kind: "audio" | "camera",
  durationMs: number,
  media: {
    mimeType?: string;
    source?: RecordingAudioSource | RecordingCameraSource;
    startOffsetMs: number;
  },
): RecordingTrackMeta {
  return {
    id: kind,
    kind,
    mimeType: media.mimeType || undefined,
    source: media.source,
    startOffsetMs: media.startOffsetMs,
    durationMs: Math.max(0, durationMs - media.startOffsetMs),
  };
}

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
  const trackMetadata = buildEventTrackMetadata(tracks, duration);
  if (audio.blob || audio.pending) {
    trackMetadata.push(
      buildMediaTrackMetadata("audio", duration, {
        mimeType: audio.mimeType || audio.blob?.type,
        source: audio.source,
        startOffsetMs: audio.startOffsetMs,
      }),
    );
  }
  if (camera.blob) {
    trackMetadata.push(
      buildMediaTrackMetadata("camera", duration, {
        mimeType: camera.mimeType || camera.blob.type,
        source: camera.source,
        startOffsetMs: camera.startOffsetMs,
      }),
    );
  }
  // One clock read, so the id, the name and createdAt name the same instant.
  const createdAt = Date.now();

  return {
    version: DELTA_CONFIG.VERSION,
    id: String(createdAt),
    name: `Recording ${createdAt}`,
    createdAt,
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
