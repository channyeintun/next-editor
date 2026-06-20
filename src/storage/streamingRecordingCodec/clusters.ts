import type { Recording } from "../../core/src";
import type {
  RecordingClusterMeta,
  RecordingMediaFragment,
  RecordingTrackMeta,
} from "../../core/src/types";
import type { DeltaFrame } from "../../core/src/utils/deltaTypes";
import { isKeyframe } from "../../core/src/utils/deltaTypes";
import {
  clampU32,
  DEFAULT_AUDIO_TRACK_ID,
  DEFAULT_CAMERA_TRACK_ID,
  readRecordTimestamp,
} from "./format";

// ============================================================================
// Recording metadata derivation.
//
// A `Recording` may already carry explicit tracks/clusters/media-fragments (when
// it was decoded from a stream that recorded them), or it may carry none (a
// freshly captured recording). These helpers fill in the gaps so the encoder
// always has a consistent track/cluster/fragment view to write, and so the
// decoder can reconstruct the same view from segments. No bytes here — pure
// metadata.
// ============================================================================

export function resolveClusterIndexForTime(
  clusters: ReadonlyArray<RecordingClusterMeta>,
  timeMs: number,
): number {
  if (clusters.length === 0) {
    return 0;
  }

  for (let index = clusters.length - 1; index >= 0; index -= 1) {
    if (timeMs >= clusters[index].startTimeMs) {
      return clusters[index].index;
    }
  }

  return clusters[0].index;
}

export function getTrackId(
  tracks: ReadonlyArray<RecordingTrackMeta> | undefined,
  kind: RecordingTrackMeta["kind"],
  fallback: string,
): string {
  return tracks?.find((track) => track.kind === kind)?.id ?? fallback;
}

function buildClustersFromFrames(frames: DeltaFrame[], duration: number): RecordingClusterMeta[] {
  if (frames.length === 0) {
    return duration > 0
      ? [{ index: 0, startTimeMs: 0, endTimeMs: duration, containsKeyframe: false }]
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
    const nextStartTimeMs = endIndex < frames.length ? frames[endIndex].timestamp : duration;
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
    lastCluster.endTimeMs = Math.max(lastCluster.startTimeMs, lastCluster.endTimeMs, duration);
  }

  return clusters;
}

function buildClustersFromMediaFragments(
  fragments: ReadonlyArray<RecordingMediaFragment>,
  duration: number,
): RecordingClusterMeta[] {
  if (fragments.length === 0) {
    return duration > 0
      ? [{ index: 0, startTimeMs: 0, endTimeMs: duration, containsKeyframe: false }]
      : [];
  }

  const clusterMap = new Map<number, RecordingClusterMeta>();

  for (const fragment of fragments) {
    const existing = clusterMap.get(fragment.clusterIndex);
    if (existing) {
      existing.startTimeMs = Math.min(existing.startTimeMs, fragment.startTimeMs);
      existing.endTimeMs = Math.max(existing.endTimeMs, fragment.endTimeMs);
      continue;
    }

    clusterMap.set(fragment.clusterIndex, {
      index: fragment.clusterIndex,
      startTimeMs: fragment.startTimeMs,
      endTimeMs: fragment.endTimeMs,
      containsKeyframe: false,
    });
  }

  const clusters = Array.from(clusterMap.values()).sort((left, right) => left.index - right.index);
  const lastCluster = clusters[clusters.length - 1];
  if (lastCluster) {
    lastCluster.endTimeMs = Math.max(lastCluster.endTimeMs, duration);
  }
  return clusters;
}

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

  if (recording.frames.length > 0) {
    return buildClustersFromFrames(recording.frames, recording.duration);
  }

  return buildClustersFromMediaFragments(recording.mediaFragments ?? [], recording.duration);
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
  if (recording.audioBlob instanceof Blob && recording.audioBlob.size > 0) {
    const startOffsetMs = recording.audioStartOffsetMs ?? 0;
    tracks.push({
      id: DEFAULT_AUDIO_TRACK_ID,
      kind: "audio",
      mimeType: recording.audioBlob.type || undefined,
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

export function deriveRecordingMediaFragments(
  recording: Recording,
  tracks: ReadonlyArray<RecordingTrackMeta>,
  clusters: ReadonlyArray<RecordingClusterMeta>,
): RecordingMediaFragment[] {
  if (recording.mediaFragments && recording.mediaFragments.length > 0) {
    return recording.mediaFragments
      .map((fragment) => ({ ...fragment }))
      .sort(
        (left, right) =>
          left.startTimeMs - right.startTimeMs || left.clusterIndex - right.clusterIndex,
      );
  }

  const fragments: RecordingMediaFragment[] = [];

  if (recording.audioBlob instanceof Blob && recording.audioBlob.size > 0) {
    const startTimeMs = recording.audioStartOffsetMs ?? 0;
    fragments.push({
      trackId: getTrackId(tracks, "audio", DEFAULT_AUDIO_TRACK_ID),
      clusterIndex: resolveClusterIndexForTime(clusters, startTimeMs),
      startTimeMs,
      endTimeMs: Math.max(startTimeMs, recording.duration),
      byteLength: recording.audioBlob.size,
      isInit: true,
    });
  }

  if (recording.cameraBlob instanceof Blob && recording.cameraBlob.size > 0) {
    const startTimeMs = recording.cameraStartOffsetMs ?? 0;
    fragments.push({
      trackId: getTrackId(tracks, "camera", DEFAULT_CAMERA_TRACK_ID),
      clusterIndex: resolveClusterIndexForTime(clusters, startTimeMs),
      startTimeMs,
      endTimeMs: Math.max(startTimeMs, recording.duration),
      byteLength: recording.cameraBlob.size,
      isInit: true,
    });
  }

  return fragments;
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

/** Splits frames into keyframe-anchored batches: each batch starts at a keyframe. */
export function batchFramesByKeyframe(frames: DeltaFrame[]): DeltaFrame[][] {
  const batches: DeltaFrame[][] = [];
  let index = 0;
  while (index < frames.length) {
    const start = index;
    index += 1;
    while (index < frames.length && !isKeyframe(frames[index])) {
      index += 1;
    }
    batches.push(frames.slice(start, index));
  }
  return batches;
}
