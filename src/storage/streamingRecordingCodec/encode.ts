import type { Recording } from "../../core/src";
import type { RecordingClusterMeta } from "../../core/src/types";
import type { DeltaFrame } from "../../core/src/utils/deltaTypes";
import { isKeyframe } from "../../core/src/utils/deltaTypes";
import { normalizeRecordingData } from "../../core/src/utils/editorState";
import type { WorkspaceRecordingAsset } from "../../types/workspace";
import { iterateRecordingWorkspaceAssets } from "../recordingWorkspaceAssets";
import {
  audioMimeFromFilename,
  buildFooterChunk,
  buildHeaderChunk,
  buildSegmentChunk,
  cameraMimeFromFilename,
  clampU32,
  concatChunks,
  encodeRecords,
  encodeWorkspaceAssetPayload,
  FLAG_HAS_AUDIO,
  FLAG_HAS_CAMERA,
  readLastRecordTimestamp,
  readRecordTimestamp,
  RECORDING_EVENT_SEGMENTS,
  SEGMENT_KIND,
  type RecordingStreamMeta,
  type SegmentIndexEntry,
  type SegmentKind,
} from "./format";
import {
  batchFramesByKeyframe,
  deriveRecordingClusters,
  deriveRecordingTracks,
  groupRecordsByCluster,
  resolveClusterIndexForTime,
} from "./clusters";
import { stripFramePreviewContent } from "./framePreviewContentDedup";
import { createPreviewAddNodeStripper } from "./previewPatchDedup";
import { createWorkspaceEventContentStripper } from "./workspaceEventDedup";

// ============================================================================
// Encoding: turn a `Recording` into SCR3 bytes.
//
// `createStreamingRecordingWriter` is the low-level, append-as-you-go writer used
// while recording live. `encodeRecordingToStream` is the one-shot exporter that
// writes raw workspace assets once, then orders frame/event segments by cluster and time, so a
// finalized file is laid out for seeking.
// ============================================================================

export interface StreamingSegmentAppendOptions {
  startTimeMs?: number;
  endTimeMs?: number;
  clusterIndex?: number;
  firstFrameIndex?: number;
  containsKeyframe?: boolean;
  isInit?: boolean;
}

export interface StreamingRecordingWriter {
  writeHeader(meta: RecordingStreamMeta): void;
  appendFrameSegment(frames: DeltaFrame[], options?: StreamingSegmentAppendOptions): void;
  appendEventSegment(
    kind: SegmentKind,
    records: ReadonlyArray<unknown>,
    options?: StreamingSegmentAppendOptions,
  ): void;
  appendWorkspaceAssetSegment(
    asset: WorkspaceRecordingAsset,
    options?: StreamingSegmentAppendOptions,
  ): void;
  appendFinalMetadata(meta: RecordingStreamMeta): void;
  /** Finalize and materialize a one-shot stream. Invalid after bytes have been drained. */
  finalize(): Uint8Array;
  /** Append the footer without copying historical bytes (for a draining live writer). */
  finalizeStream(): void;
  drainPending(): Uint8Array;
  retainedByteLength(): number;
  isFinalized(): boolean;
}

export function createStreamingRecordingWriter(): StreamingRecordingWriter {
  const chunks: Uint8Array[] = [];
  const index: SegmentIndexEntry[] = [];
  let length = 0;
  let pendingLength = 0;
  let hasDrained = false;
  let headerWritten = false;
  let finalized = false;
  let frameCount = 0;
  let nextFrameClusterIndex = 0;
  let headerMeta: RecordingStreamMeta | null = null;
  // Workspace events each embed the project graph. Repeated text is stripped to
  // a marker; binary bytes live in separate raw workspace-asset segments.
  const stripWorkspaceEvents = createWorkspaceEventContentStripper();
  // rrweb mutation adds re-serialize identical node payloads on content churn
  // (virtualized lists remounting rows); repeats are stripped to a template
  // marker here and rebuilt on decode — see previewPatchDedup.ts.
  const stripPreviewPatchAdds = createPreviewAddNodeStripper();

  const pushChunk = (bytes: Uint8Array): void => {
    chunks.push(bytes);
    length += bytes.length;
    pendingLength += bytes.length;
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
    options: StreamingSegmentAppendOptions,
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
      // Repeated previewState contents are stripped per segment (frame segments
      // are keyframe-bounded and range-loadable, so the carry must not cross a
      // segment boundary) — see framePreviewContentDedup.ts.
      appendSegment(SEGMENT_KIND.frames, encodeRecords(stripFramePreviewContent(frames)), {
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
      const streamRecords =
        kind === SEGMENT_KIND.workspace
          ? stripWorkspaceEvents(records)
          : kind === SEGMENT_KIND.previewPatch
            ? stripPreviewPatchAdds(records)
            : records;
      appendSegment(kind, encodeRecords(streamRecords), {
        startTimeMs: options?.startTimeMs ?? readRecordTimestamp(records[0]),
        endTimeMs: options?.endTimeMs ?? readLastRecordTimestamp(records),
        firstFrameIndex: options?.firstFrameIndex ?? -1,
        clusterIndex: options?.clusterIndex,
        containsKeyframe: options?.containsKeyframe,
        isInit: options?.isInit,
      });
    },
    appendWorkspaceAssetSegment(asset, options) {
      ensureWritable();
      appendSegment(SEGMENT_KIND.workspaceAsset, encodeWorkspaceAssetPayload(asset), {
        startTimeMs: options?.startTimeMs ?? 0,
        endTimeMs: options?.endTimeMs ?? options?.startTimeMs ?? 0,
        firstFrameIndex: -1,
        clusterIndex: options?.clusterIndex ?? 0,
      });
    },
    appendFinalMetadata(meta) {
      ensureWritable();
      appendSegment(SEGMENT_KIND.finalMeta, encodeRecords([meta]), {
        startTimeMs: meta.duration,
        endTimeMs: meta.duration,
        clusterIndex: Math.max(0, (meta.clusters?.length ?? 1) - 1),
      });
    },
    finalize() {
      ensureWritable();
      if (hasDrained) {
        throw new Error("Cannot materialize an SCR3 stream after bytes have been drained");
      }
      pushChunk(buildFooterChunk(index));
      finalized = true;
      return concatChunks(chunks, length);
    },
    finalizeStream() {
      ensureWritable();
      pushChunk(buildFooterChunk(index));
      finalized = true;
    },
    drainPending() {
      if (chunks.length === 0) return new Uint8Array(0);
      const pending = concatChunks(chunks, pendingLength);
      chunks.length = 0;
      pendingLength = 0;
      hasDrained = true;
      return pending;
    },
    retainedByteLength() {
      return pendingLength;
    },
    isFinalized() {
      return finalized;
    },
  };
}

function buildRecordingStreamMeta(
  normalized: Recording,
  tracks = deriveRecordingTracks(normalized),
  clusters = deriveRecordingClusters(normalized),
): RecordingStreamMeta {
  // Audio is never embedded in the stream — its bytes live in a sibling file/blob referenced
  // by `audioFile`/`audioUrl` (or attached in memory as `audioBlob`). The stream carries only
  // the reference and metadata in its header, keeping the `.ne` small.
  const hasAudio = Boolean(
    normalized.audioFile ||
    normalized.audioUrl ||
    normalized.audioSource ||
    (normalized.audioBlob instanceof Blob && normalized.audioBlob.size > 0),
  );
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
  return {
    version: normalized.version,
    id: normalized.id,
    name: normalized.name,
    keyframeInterval: normalized.keyframeInterval,
    createdAt: normalized.createdAt,
    duration: normalized.duration,
    tracks,
    clusters,
    audioType: hasAudio
      ? audioTrack?.mimeType || audioMimeFromFilename(normalized.audioFile) || "audio/webm"
      : undefined,
    audioSource: hasAudio ? normalized.audioSource : undefined,
    audioStartOffsetMs: hasAudio ? normalized.audioStartOffsetMs : undefined,
    audioFile: normalized.audioFile,
    audioUrl: normalized.audioUrl,
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
  };
}

/** Build the authoritative metadata shared by one-shot and finalized live streams. */
export function createRecordingStreamMeta(recording: Recording): RecordingStreamMeta {
  return buildRecordingStreamMeta(normalizeRecordingData(recording));
}

export async function encodeRecordingToStream(recording: Recording): Promise<Uint8Array> {
  const normalized = normalizeRecordingData(recording);
  const tracks = deriveRecordingTracks(normalized);
  const clusters = deriveRecordingClusters(normalized);
  const writer = createStreamingRecordingWriter();

  writer.writeHeader(buildRecordingStreamMeta(normalized, tracks, clusters));

  for await (const asset of iterateRecordingWorkspaceAssets(normalized)) {
    writer.appendWorkspaceAssetSegment(asset);
  }

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

  for (const { kind, key } of RECORDING_EVENT_SEGMENTS) {
    queueClusteredEventSegments(kind, normalized[key], 1);
  }

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
