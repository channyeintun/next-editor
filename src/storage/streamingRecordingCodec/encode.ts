import type { Recording } from "../../core/src";
import type { RecordingClusterMeta, RecordingTrackMeta } from "../../core/src/types";
import type { DeltaFrame } from "../../core/src/utils/deltaTypes";
import { isKeyframe } from "../../core/src/utils/deltaTypes";
import { normalizeRecordingData } from "../../core/src/utils/editorState";
import {
  buildFooterChunk,
  buildHeaderChunk,
  buildSegmentChunk,
  cameraMimeFromFilename,
  clampU32,
  concatChunks,
  DEFAULT_AUDIO_TRACK_ID,
  DEFAULT_CAMERA_TRACK_ID,
  encodeRecords,
  FLAG_HAS_AUDIO,
  FLAG_HAS_CAMERA,
  readLastRecordTimestamp,
  readRecordTimestamp,
  SEGMENT_KIND,
  type MaterializedMediaSegment,
  type RecordingStreamMeta,
  type SegmentIndexEntry,
  type SegmentKind,
} from "./format";
import {
  batchFramesByKeyframe,
  deriveRecordingClusters,
  deriveRecordingMediaFragments,
  deriveRecordingTracks,
  getTrackId,
  groupRecordsByCluster,
  resolveClusterIndexForTime,
} from "./clusters";

// ============================================================================
// Encoding: turn a `Recording` into SCR3 bytes.
//
// `createStreamingRecordingWriter` is the low-level, append-as-you-go writer used
// while recording live. `encodeRecordingToStream` is the one-shot exporter that
// orders every frame/event/media segment by cluster and time before writing, so a
// finalized file is laid out for seeking.
// ============================================================================

interface SegmentAppendOptions {
  startTimeMs?: number;
  endTimeMs?: number;
  clusterIndex?: number;
  firstFrameIndex?: number;
  containsKeyframe?: boolean;
  isInit?: boolean;
}

export interface StreamingRecordingWriter {
  writeHeader(meta: RecordingStreamMeta): void;
  appendFrameSegment(frames: DeltaFrame[], options?: SegmentAppendOptions): void;
  appendEventSegment(
    kind: SegmentKind,
    records: ReadonlyArray<unknown>,
    options?: SegmentAppendOptions,
  ): void;
  appendAudioChunk(chunk: Uint8Array, options?: SegmentAppendOptions): void;
  finalize(): Uint8Array;
  drainPending(): Uint8Array;
  isFinalized(): boolean;
}

export function createStreamingRecordingWriter(): StreamingRecordingWriter {
  const chunks: Uint8Array[] = [];
  const index: SegmentIndexEntry[] = [];
  let length = 0;
  let drainedChunkCount = 0;
  let headerWritten = false;
  let finalized = false;
  let frameCount = 0;
  let nextFrameClusterIndex = 0;
  let headerMeta: RecordingStreamMeta | null = null;

  const pushChunk = (bytes: Uint8Array): void => {
    chunks.push(bytes);
    length += bytes.length;
  };

  const ensureWritable = (): void => {
    if (!headerWritten) throw new Error("SCR3 header not written");
    if (finalized) throw new Error("SCR3 stream already finalized");
  };

  const resolveClusterIndex = (
    startTimeMs: number,
    kind: number,
    providedClusterIndex?: number,
  ): number => {
    if (typeof providedClusterIndex === "number" && Number.isFinite(providedClusterIndex)) {
      return Math.max(0, Math.trunc(providedClusterIndex));
    }

    if (headerMeta?.clusters?.length) {
      return resolveClusterIndexForTime(headerMeta.clusters, startTimeMs);
    }

    return kind === SEGMENT_KIND.frames ? nextFrameClusterIndex : 0;
  };

  const appendSegment = (
    kind: number,
    payload: Uint8Array,
    options: SegmentAppendOptions,
  ): void => {
    const startTimeMs = clampU32(options.startTimeMs ?? 0);
    const endTimeMs = clampU32(Math.max(startTimeMs, options.endTimeMs ?? startTimeMs));
    const firstFrameIndex = options.firstFrameIndex ?? -1;
    const containsKeyframe = Boolean(options.containsKeyframe);
    const clusterIndex = resolveClusterIndex(startTimeMs, kind, options.clusterIndex);
    const byteOffset = length;

    pushChunk(
      buildSegmentChunk(
        kind,
        payload,
        startTimeMs,
        endTimeMs,
        firstFrameIndex,
        clusterIndex,
        containsKeyframe,
        Boolean(options.isInit),
      ),
    );

    index.push({ kind, byteOffset, firstTimestampMs: startTimeMs, firstFrameIndex });

    if (kind === SEGMENT_KIND.frames) {
      nextFrameClusterIndex = Math.max(nextFrameClusterIndex, clusterIndex + 1);
    }
  };

  return {
    writeHeader(meta) {
      if (headerWritten) throw new Error("SCR3 header already written");
      const flags = (meta.audioType ? FLAG_HAS_AUDIO : 0) | (meta.cameraType ? FLAG_HAS_CAMERA : 0);
      pushChunk(buildHeaderChunk(meta, flags));
      headerMeta = meta;
      headerWritten = true;
    },
    appendFrameSegment(frames, options) {
      ensureWritable();
      if (frames.length === 0) return;
      appendSegment(SEGMENT_KIND.frames, encodeRecords(frames), {
        startTimeMs: options?.startTimeMs ?? frames[0].timestamp,
        endTimeMs: options?.endTimeMs ?? readLastRecordTimestamp(frames),
        firstFrameIndex: options?.firstFrameIndex ?? frameCount,
        clusterIndex: options?.clusterIndex,
        containsKeyframe: options?.containsKeyframe ?? frames.some(isKeyframe),
        isInit: options?.isInit,
      });
      frameCount += frames.length;
    },
    appendEventSegment(kind, records, options) {
      ensureWritable();
      if (records.length === 0) return;
      appendSegment(kind, encodeRecords(records), {
        startTimeMs: options?.startTimeMs ?? readRecordTimestamp(records[0]),
        endTimeMs: options?.endTimeMs ?? readLastRecordTimestamp(records),
        firstFrameIndex: options?.firstFrameIndex ?? -1,
        clusterIndex: options?.clusterIndex,
        containsKeyframe: options?.containsKeyframe,
        isInit: options?.isInit,
      });
    },
    appendAudioChunk(chunk, options) {
      ensureWritable();
      if (chunk.length === 0) return;
      const startTimeMs = options?.startTimeMs ?? headerMeta?.audioStartOffsetMs ?? 0;
      appendSegment(SEGMENT_KIND.audioChunk, chunk, {
        startTimeMs,
        endTimeMs: options?.endTimeMs ?? startTimeMs,
        firstFrameIndex: options?.firstFrameIndex ?? -1,
        clusterIndex: options?.clusterIndex,
        isInit: options?.isInit,
      });
    },
    finalize() {
      ensureWritable();
      pushChunk(buildFooterChunk(index));
      finalized = true;
      return concatChunks(chunks, length);
    },
    drainPending() {
      const pending = chunks.slice(drainedChunkCount);
      drainedChunkCount = chunks.length;
      return concatChunks(pending);
    },
    isFinalized() {
      return finalized;
    },
  };
}

function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }
      reject(new Error("Failed to read media blob as ArrayBuffer"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read media blob"));
    reader.readAsArrayBuffer(blob);
  });
}

async function materializeMediaSegments(
  recording: Recording,
  kind: "audio" | "camera",
  tracks: ReadonlyArray<RecordingTrackMeta>,
  clusters: ReadonlyArray<RecordingClusterMeta>,
): Promise<MaterializedMediaSegment[]> {
  const blob = kind === "audio" ? recording.audioBlob : recording.cameraBlob;
  const defaultTrackId = kind === "audio" ? DEFAULT_AUDIO_TRACK_ID : DEFAULT_CAMERA_TRACK_ID;
  const trackKind = kind === "audio" ? "audio" : "camera";
  const startOffsetMs =
    kind === "audio" ? (recording.audioStartOffsetMs ?? 0) : (recording.cameraStartOffsetMs ?? 0);
  const trackId = getTrackId(tracks, trackKind, defaultTrackId);

  const metadata = deriveRecordingMediaFragments(recording, tracks, clusters)
    .filter((fragment) => fragment.trackId === trackId)
    .sort(
      (left, right) =>
        left.startTimeMs - right.startTimeMs || left.clusterIndex - right.clusterIndex,
    );

  if (metadata.length > 0 && metadata.every((fragment) => fragment.bytes instanceof Uint8Array)) {
    return metadata.map((fragment) => ({
      ...fragment,
      bytes: (fragment.bytes as Uint8Array).slice(),
      byteLength: fragment.byteLength ?? (fragment.bytes as Uint8Array).length,
    }));
  }

  if (!(blob instanceof Blob) || blob.size === 0) {
    return [];
  }

  const bytes = new Uint8Array(await readBlobAsArrayBuffer(blob));
  const fallbackMetadata =
    metadata.length > 0
      ? metadata
      : [
          {
            trackId,
            clusterIndex: resolveClusterIndexForTime(clusters, startOffsetMs),
            startTimeMs: startOffsetMs,
            endTimeMs: Math.max(startOffsetMs, recording.duration),
            byteLength: bytes.length,
            isInit: true,
          },
        ];

  let offset = 0;
  return fallbackMetadata
    .map((fragment, index) => {
      const remaining = Math.max(0, bytes.length - offset);
      const expectedLength =
        typeof fragment.byteLength === "number" && Number.isFinite(fragment.byteLength)
          ? Math.max(0, Math.trunc(fragment.byteLength))
          : remaining;
      const takeLength =
        index === fallbackMetadata.length - 1 ? remaining : Math.min(remaining, expectedLength);
      const fragmentBytes = bytes.subarray(offset, offset + takeLength).slice();
      offset += takeLength;
      return {
        ...fragment,
        bytes: fragmentBytes,
        byteLength: fragmentBytes.length,
        isInit: fragment.isInit ?? index === 0,
      };
    })
    .filter((fragment) => fragment.bytes.length > 0);
}

export async function encodeRecordingToStream(recording: Recording): Promise<Uint8Array> {
  const normalized = normalizeRecordingData(recording);
  const tracks = deriveRecordingTracks(normalized);
  const clusters = deriveRecordingClusters(normalized);
  const audioFragments = await materializeMediaSegments(normalized, "audio", tracks, clusters);
  // Camera video is never embedded in the stream — its bytes live in a separate file/blob. The
  // stream carries only the camera reference and metadata in its header.
  const hasCamera = Boolean(
    normalized.cameraBlob ||
    normalized.cameraFile ||
    normalized.cameraUrl ||
    normalized.cameraSource,
  );
  const audioTrack = tracks.find((track) => track.kind === "audio");
  const cameraTrack = tracks.find((track) => track.kind === "camera");
  const writer = createStreamingRecordingWriter();

  writer.writeHeader({
    version: normalized.version,
    id: normalized.id,
    name: normalized.name,
    keyframeInterval: normalized.keyframeInterval,
    createdAt: normalized.createdAt,
    duration: normalized.duration,
    tracks,
    clusters,
    audioType: audioFragments.length > 0 ? audioTrack?.mimeType || "audio/webm" : undefined,
    audioSource: audioFragments.length > 0 ? normalized.audioSource : undefined,
    audioStartOffsetMs: audioFragments.length > 0 ? normalized.audioStartOffsetMs : undefined,
    cameraType: hasCamera
      ? cameraTrack?.mimeType || cameraMimeFromFilename(normalized.cameraFile) || "video/webm"
      : undefined,
    cameraSource: hasCamera ? normalized.cameraSource : undefined,
    cameraStartOffsetMs: hasCamera ? normalized.cameraStartOffsetMs : undefined,
    cameraFile: normalized.cameraFile,
    cameraUrl: normalized.cameraUrl,
    captions: normalized.captions,
    captionFiles: normalized.captionFiles,
    slides: normalized.slides,
    workspaceSnapshot: normalized.workspaceSnapshot,
    runtimeSnapshot: normalized.runtimeSnapshot,
  });

  const pendingSegments: Array<{
    clusterIndex: number;
    startTimeMs: number;
    priority: number;
    write: () => void;
  }> = [];

  const frameBatches = batchFramesByKeyframe(normalized.frames);
  frameBatches.forEach((batch, batchIndex) => {
    const clusterIndex = resolveClusterIndexForTime(clusters, batch[0]?.timestamp ?? 0);
    const cluster =
      clusters.find((candidate) => candidate.index === clusterIndex) ??
      ({
        index: batchIndex,
        startTimeMs: batch[0]?.timestamp ?? 0,
        endTimeMs: Math.max(batch[batch.length - 1]?.timestamp ?? 0, normalized.duration),
        containsKeyframe: batch.some(isKeyframe),
      } as RecordingClusterMeta);

    pendingSegments.push({
      clusterIndex,
      startTimeMs: cluster.startTimeMs,
      priority: 0,
      write: () =>
        writer.appendFrameSegment(batch, {
          startTimeMs: cluster.startTimeMs,
          endTimeMs: cluster.endTimeMs,
          clusterIndex,
          containsKeyframe: cluster.containsKeyframe,
        }),
    });
  });

  const queueClusteredEventSegments = (
    kind: SegmentKind,
    records: ReadonlyArray<unknown> | undefined,
    priority: number,
  ): void => {
    if (!records || records.length === 0) return;
    for (const [clusterIndex, grouped] of groupRecordsByCluster(records, clusters)) {
      const cluster =
        clusters.find((candidate) => candidate.index === clusterIndex) ??
        ({
          index: clusterIndex,
          startTimeMs: readRecordTimestamp(grouped[0]),
          endTimeMs: readLastRecordTimestamp(grouped),
          containsKeyframe: false,
        } as RecordingClusterMeta);

      pendingSegments.push({
        clusterIndex,
        startTimeMs: readRecordTimestamp(grouped[0]),
        priority,
        write: () =>
          writer.appendEventSegment(kind, grouped, {
            startTimeMs: readRecordTimestamp(grouped[0]),
            endTimeMs: Math.max(readLastRecordTimestamp(grouped), cluster.endTimeMs),
            clusterIndex,
          }),
      });
    }
  };

  queueClusteredEventSegments(SEGMENT_KIND.slide, normalized.slideEvents, 1);
  queueClusteredEventSegments(SEGMENT_KIND.preview, normalized.previewEvents, 1);
  queueClusteredEventSegments(SEGMENT_KIND.previewDoc, normalized.previewInitialDocuments, 1);
  queueClusteredEventSegments(SEGMENT_KIND.previewPatch, normalized.previewPatchBatches, 1);
  queueClusteredEventSegments(SEGMENT_KIND.workspace, normalized.workspaceEvents, 1);
  queueClusteredEventSegments(SEGMENT_KIND.runtime, normalized.runtimeEvents, 1);
  queueClusteredEventSegments(SEGMENT_KIND.cursor, normalized.cursorEvents, 1);

  audioFragments.forEach((fragment, index) => {
    pendingSegments.push({
      clusterIndex: fragment.clusterIndex,
      startTimeMs: fragment.startTimeMs,
      priority: 2,
      write: () =>
        writer.appendAudioChunk(fragment.bytes, {
          startTimeMs: fragment.startTimeMs,
          endTimeMs: fragment.endTimeMs,
          clusterIndex: fragment.clusterIndex,
          isInit: fragment.isInit ?? index === 0,
        }),
    });
  });

  pendingSegments
    .sort(
      (left, right) =>
        left.clusterIndex - right.clusterIndex ||
        left.startTimeMs - right.startTimeMs ||
        left.priority - right.priority,
    )
    .forEach((segment) => {
      segment.write();
    });

  return writer.finalize();
}
