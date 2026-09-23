import type { Recording } from "../../core/src";
import type { RecordingClusterMeta, RecordingTrackMeta } from "../../core/src/types";
import {
  buildRecordingClusters,
  resolveClusterIndexForTime,
} from "../../core/src/utils/recordingClusters";
import {
  clampU32,
  DEFAULT_AUDIO_TRACK_ID,
  DEFAULT_CAMERA_TRACK_ID,
  readRecordTimestamp,
} from "./format";

// ============================================================================
// Recording metadata derivation.
//
// A `Recording` usually carries its tracks and clusters (capture builds them and
// decoding restores them), but need not. These helpers fill in the gaps so the
// encoder always has a consistent track/cluster view to write, and so the decoder
// can derive what a stream's metadata leaves out. No bytes here — pure metadata.
// ============================================================================

export function deriveRecordingClusters(recording: Recording): RecordingClusterMeta[] {
  if (recording.clusters && recording.clusters.length > 0) {
    return [...recording.clusters]
      .map((cluster) => ({
        index: Math.max(0, Math.trunc(cluster.index)),
        startTimeMs: clampU32(cluster.startTimeMs),
        endTimeMs: Math.max(clampU32(cluster.startTimeMs), clampU32(cluster.endTimeMs)),
        containsKeyframe: Boolean(cluster.containsKeyframe),
      }))
      .sort((left, right) => left.index - right.index);
  }

  return buildRecordingClusters(recording.frames, recording.duration);
}

export function deriveRecordingTracks(recording: Recording): RecordingTrackMeta[] {
  if (recording.tracks && recording.tracks.length > 0) {
    return recording.tracks.map((track) => ({ ...track }));
  }

  const tracks: RecordingTrackMeta[] = [
    { id: "editor", kind: "editor", durationMs: recording.duration },
  ];

  if (recording.slideEvents?.length) {
    tracks.push({ id: "slide", kind: "slide", durationMs: recording.duration });
  }
  if (
    recording.previewEvents?.length ||
    recording.previewInitialDocuments?.length ||
    recording.previewPatchBatches?.length
  ) {
    tracks.push({ id: "preview", kind: "preview", durationMs: recording.duration });
  }
  if (recording.workspaceEvents?.length) {
    tracks.push({ id: "workspace", kind: "workspace", durationMs: recording.duration });
  }
  if (recording.runtimeEvents?.length) {
    tracks.push({ id: "runtime", kind: "runtime", durationMs: recording.duration });
  }
  if (recording.cursorEvents?.length) {
    tracks.push({ id: "cursor", kind: "cursor", durationMs: recording.duration });
  }
  if (recording.whiteboardEvents?.length) {
    tracks.push({ id: "whiteboard", kind: "whiteboard", durationMs: recording.duration });
  }
  if (recording.chatEvents?.length) {
    tracks.push({ id: "chat", kind: "chat", durationMs: recording.duration });
  }
  const hasInlineAudio = recording.audioBlob instanceof Blob && recording.audioBlob.size > 0;
  // External audio (sibling file/URL) carries no blob but is still an audio track.
  if (hasInlineAudio || recording.audioFile || recording.audioUrl) {
    const startOffsetMs = recording.audioStartOffsetMs ?? 0;
    tracks.push({
      id: DEFAULT_AUDIO_TRACK_ID,
      kind: "audio",
      mimeType: (hasInlineAudio && (recording.audioBlob as Blob).type) || undefined,
      source: recording.audioSource,
      startOffsetMs,
      durationMs: Math.max(0, recording.duration - startOffsetMs),
    });
  }
  if (recording.cameraBlob instanceof Blob && recording.cameraBlob.size > 0) {
    const startOffsetMs = recording.cameraStartOffsetMs ?? 0;
    tracks.push({
      id: DEFAULT_CAMERA_TRACK_ID,
      kind: "camera",
      mimeType: recording.cameraBlob.type || undefined,
      source: recording.cameraSource,
      startOffsetMs,
      durationMs: Math.max(0, recording.duration - startOffsetMs),
    });
  }

  return tracks;
}

/**
 * Folds a segment's time span into the running per-cluster summary map used while
 * decoding, widening the cluster's bounds and OR-ing its keyframe flag.
 */
export function mergeClusterSummary(
  map: Map<number, RecordingClusterMeta>,
  clusterIndex: number,
  startTimeMs: number,
  endTimeMs: number,
  containsKeyframe: boolean,
): void {
  const existing = map.get(clusterIndex);
  if (existing) {
    existing.startTimeMs = Math.min(existing.startTimeMs, startTimeMs);
    existing.endTimeMs = Math.max(existing.endTimeMs, endTimeMs);
    existing.containsKeyframe = existing.containsKeyframe || containsKeyframe;
    return;
  }
  map.set(clusterIndex, { index: clusterIndex, startTimeMs, endTimeMs, containsKeyframe });
}

/** Buckets timeline records by the cluster their timestamp falls into (for writing). */
export function groupRecordsByCluster<T>(
  records: ReadonlyArray<T>,
  clusters: ReadonlyArray<RecordingClusterMeta>,
): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const record of records) {
    const clusterIndex = resolveClusterIndexForTime(clusters, readRecordTimestamp(record));
    const existing = grouped.get(clusterIndex);
    if (existing) {
      existing.push(record);
      continue;
    }
    grouped.set(clusterIndex, [record]);
  }
  return grouped;
}
