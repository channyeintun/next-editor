import { decode as msgpackDecode, encode as msgpackEncode } from "@msgpack/msgpack";
import { deflate, inflate } from "pako";
import type { Recording } from "../core/src";
import type {
  CursorRecordingEvent,
  RecordingAudioSource,
  RecordingCameraSource,
  RecordingClusterMeta,
  RecordingMediaFragment,
  RecordingTrackMeta,
} from "../core/src/types";
import type {
  PreviewDomPatchBatch,
  PreviewEvent,
  PreviewInitialDocument,
  Slide,
  SlideEvent,
} from "../core/src/slides";
import type { DeltaFrame } from "../core/src/utils/deltaTypes";
import { isKeyframe } from "../core/src/utils/deltaTypes";
import { normalizeRecordingData } from "../core/src/utils/editorState";
import type { RuntimeRecordingEvent, RuntimeRecordingSnapshot } from "../types/runtime";
import type { WorkspaceRecordingEvent, WorkspaceRecordingSnapshot } from "../types/workspace";

// ============================================================================
// SCR3 — append-only, seekable, range-loadable recording stream container.
//
// A single recording serializes to one self-describing stream. The same byte
// layout is produced whether the stream is built live (segment-by-segment) or
// exported in one shot, so a still-recording prefix is replayable and a
// finalized file is seekable via its footer index.
//
// Three independent "version" numbers exist; do not conflate them:
//   * STREAM_MAGIC ("SCR3")     — container family marker (the file magic).
//   * STREAM_FORMAT_VERSION (2) — on-wire byte layout of the segment headers.
//                                 v1 used a 14-byte header; v2 uses 22 bytes.
//   * meta.version (2 | 3)      — the Recording *schema* version carried inside
//                                 the metadata, unrelated to the byte layout.
//
// Layout:
//   Header:  "SCR3" | formatVersion u16 | flags u16 | metaLen u32 | meta bytes
//            (meta bytes = deflate(msgpack(RecordingStreamMeta)))
//   Segment v1: kind u8 | byteLength u32 | firstTimestampMs u32 |
//               firstFrameIndex i32 | containsKeyframe u8 | payload (byteLength)
//   Segment v2: kind u8 | byteLength u32 | startTimeMs u32 | endTimeMs u32 |
//               firstFrameIndex i32 | clusterIndex u32 | flags u8 | payload
//            (payload = deflate(msgpack(records[])); media fragments are raw bytes)
//   Footer:  segmentCount u32 | index[count] | footerLen u32 | "SCR3"
//            (index entry = kind u8 | byteOffset u32 | firstTs u32 | firstIdx i32)
//
// Every segment is self-delimiting (carries its own byteLength), so a reader can
// skip an unknown future segment kind instead of aborting, and a stateful reader
// (`createStreamingRecordingReader`) can decode only newly-arrived segments for
// O(n) progressive playback rather than re-decoding the whole prefix each tick.
// ============================================================================

export const STREAM_MAGIC = "SCR3";
const STREAM_MAGIC_BYTES = new Uint8Array([0x53, 0x43, 0x52, 0x33]);
const STREAM_FORMAT_VERSION = 2;

const FLAG_HAS_AUDIO = 1 << 0;
const FLAG_HAS_CAMERA = 1 << 1;
const SEGMENT_FLAG_CONTAINS_KEYFRAME = 1 << 0;
const SEGMENT_FLAG_IS_INIT = 1 << 1;

const HEADER_PREFIX_SIZE = 12;
const LEGACY_SEGMENT_HEADER_SIZE = 14;
const SEGMENT_HEADER_SIZE = 22;
const INDEX_ENTRY_SIZE = 13;
const FOOTER_TRAILER_SIZE = 8;
const U32_MAX = 0xffffffff;
const DEFAULT_AUDIO_TRACK_ID = "audio";
const DEFAULT_CAMERA_TRACK_ID = "camera";

export const SEGMENT_KIND = {
  frames: 0,
  slide: 1,
  preview: 2,
  previewDoc: 3,
  previewPatch: 4,
  workspace: 5,
  runtime: 6,
  cursor: 7,
  audioChunk: 8,
  cameraChunk: 9,
} as const;

export type SegmentKind = (typeof SEGMENT_KIND)[keyof typeof SEGMENT_KIND];

export interface RecordingStreamMeta {
  version: 2 | 3;
  id: string;
  name: string;
  keyframeInterval: number;
  createdAt: number;
  duration: number;
  tracks?: RecordingTrackMeta[];
  clusters?: RecordingClusterMeta[];
  audioType?: string;
  audioSource?: RecordingAudioSource;
  audioStartOffsetMs?: number;
  cameraType?: string;
  cameraSource?: RecordingCameraSource;
  cameraStartOffsetMs?: number;
  slides?: Slide[];
  workspaceSnapshot?: WorkspaceRecordingSnapshot;
  runtimeSnapshot?: RuntimeRecordingSnapshot;
}

interface SegmentIndexEntry {
  kind: number;
  byteOffset: number;
  firstTimestampMs: number;
  firstFrameIndex: number;
}

interface SegmentAppendOptions {
  startTimeMs?: number;
  endTimeMs?: number;
  clusterIndex?: number;
  firstFrameIndex?: number;
  containsKeyframe?: boolean;
  isInit?: boolean;
}

interface MaterializedMediaSegment extends RecordingMediaFragment {
  bytes: Uint8Array;
}

interface SequencedMediaSegment extends MaterializedMediaSegment {
  sequence: number;
}

interface DecodedSegment {
  kind: number;
  payload: Uint8Array;
  startTimeMs: number;
  endTimeMs: number;
  firstFrameIndex: number;
  clusterIndex: number;
  containsKeyframe: boolean;
  isInit: boolean;
  sequence: number;
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
  appendCameraChunk(chunk: Uint8Array, options?: SegmentAppendOptions): void;
  finalize(): Uint8Array;
  drainPending(): Uint8Array;
  isFinalized(): boolean;
}

function clampU32(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value > U32_MAX ? U32_MAX : Math.floor(value);
}

function concatChunks(parts: Uint8Array[], totalLength?: number): Uint8Array {
  const total = totalLength ?? parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function encodeRecords(records: ReadonlyArray<unknown>): Uint8Array {
  return deflate(msgpackEncode(records, { ignoreUndefined: true }), { level: 9 });
}

function decodeRecords<T>(payload: Uint8Array): T[] {
  const decoded = msgpackDecode(inflate(payload));
  return Array.isArray(decoded) ? (decoded as T[]) : [];
}

function readRecordTimestamp(record: unknown): number {
  if (record && typeof record === "object") {
    const value = record as { timestamp?: unknown; time?: unknown };
    if (typeof value.timestamp === "number") return value.timestamp;
    if (typeof value.time === "number") return value.time;
  }
  return 0;
}

function readLastRecordTimestamp(records: ReadonlyArray<unknown>): number {
  return records.length > 0 ? readRecordTimestamp(records[records.length - 1]) : 0;
}

function resolveClusterIndexForTime(
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

function getTrackId(
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

function deriveRecordingClusters(recording: Recording): RecordingClusterMeta[] {
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

function deriveRecordingTracks(recording: Recording): RecordingTrackMeta[] {
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

function deriveRecordingMediaFragments(
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

function sortMediaSegments<T extends { startTimeMs: number; sequence: number }>(
  segments: T[],
): T[] {
  return segments.sort(
    (left, right) => left.startTimeMs - right.startTimeMs || left.sequence - right.sequence,
  );
}

function buildHeaderChunk(meta: RecordingStreamMeta, flags: number): Uint8Array {
  const metaBytes = deflate(msgpackEncode(meta, { ignoreUndefined: true }), { level: 9 });
  const chunk = new Uint8Array(HEADER_PREFIX_SIZE + metaBytes.length);
  const view = new DataView(chunk.buffer);
  chunk.set(STREAM_MAGIC_BYTES, 0);
  view.setUint16(4, STREAM_FORMAT_VERSION, true);
  view.setUint16(6, flags, true);
  view.setUint32(8, metaBytes.length, true);
  chunk.set(metaBytes, HEADER_PREFIX_SIZE);
  return chunk;
}

function buildSegmentChunk(
  kind: number,
  payload: Uint8Array,
  startTimeMs: number,
  endTimeMs: number,
  firstFrameIndex: number,
  clusterIndex: number,
  containsKeyframe: boolean,
  isInit: boolean,
): Uint8Array {
  const chunk = new Uint8Array(SEGMENT_HEADER_SIZE + payload.length);
  const view = new DataView(chunk.buffer);
  view.setUint8(0, kind);
  view.setUint32(1, payload.length, true);
  view.setUint32(5, clampU32(startTimeMs), true);
  view.setUint32(9, clampU32(Math.max(startTimeMs, endTimeMs)), true);
  view.setInt32(13, firstFrameIndex, true);
  view.setUint32(17, clampU32(clusterIndex), true);
  view.setUint8(
    21,
    (containsKeyframe ? SEGMENT_FLAG_CONTAINS_KEYFRAME : 0) | (isInit ? SEGMENT_FLAG_IS_INIT : 0),
  );
  chunk.set(payload, SEGMENT_HEADER_SIZE);
  return chunk;
}

function buildFooterChunk(index: SegmentIndexEntry[]): Uint8Array {
  const footerBodySize = 4 + index.length * INDEX_ENTRY_SIZE;
  const chunk = new Uint8Array(footerBodySize + FOOTER_TRAILER_SIZE);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, index.length, true);
  let offset = 4;
  for (const entry of index) {
    // Byte offsets are stored as u32, so the footer index cannot address past 4 GiB.
    // Clamping would silently corrupt seeks, so fail loudly instead.
    if (entry.byteOffset > U32_MAX) {
      throw new Error(
        `SCR3 stream exceeds the 4 GiB addressable limit (segment offset ${entry.byteOffset})`,
      );
    }
    view.setUint8(offset, entry.kind);
    view.setUint32(offset + 1, entry.byteOffset, true);
    view.setUint32(offset + 5, clampU32(entry.firstTimestampMs), true);
    view.setInt32(offset + 9, entry.firstFrameIndex, true);
    offset += INDEX_ENTRY_SIZE;
  }
  view.setUint32(offset, footerBodySize, true);
  offset += 4;
  chunk.set(STREAM_MAGIC_BYTES, offset);
  return chunk;
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
    appendCameraChunk(chunk, options) {
      ensureWritable();
      if (chunk.length === 0) return;
      const startTimeMs = options?.startTimeMs ?? headerMeta?.cameraStartOffsetMs ?? 0;
      appendSegment(SEGMENT_KIND.cameraChunk, chunk, {
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

function hasMagicAt(bytes: Uint8Array, offset: number): boolean {
  return (
    bytes[offset] === STREAM_MAGIC_BYTES[0] &&
    bytes[offset + 1] === STREAM_MAGIC_BYTES[1] &&
    bytes[offset + 2] === STREAM_MAGIC_BYTES[2] &&
    bytes[offset + 3] === STREAM_MAGIC_BYTES[3]
  );
}

export function isStreamingRecording(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && hasMagicAt(bytes, 0);
}

function parseHeader(bytes: Uint8Array): {
  meta: RecordingStreamMeta;
  headerEnd: number;
  formatVersion: number;
} {
  if (!isStreamingRecording(bytes)) {
    throw new Error("Invalid SCR3 stream: bad magic number");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const formatVersion = view.getUint16(4, true);
  const metaLength = view.getUint32(8, true);
  const metaStart = HEADER_PREFIX_SIZE;
  const metaEnd = metaStart + metaLength;
  if (metaLength === 0 || metaEnd > bytes.length) {
    throw new Error("Invalid SCR3 stream: bad header length");
  }
  const meta = msgpackDecode(inflate(bytes.subarray(metaStart, metaEnd))) as RecordingStreamMeta;
  return { meta, headerEnd: metaEnd, formatVersion };
}

function findFooterStart(bytes: Uint8Array, headerEnd: number): number | null {
  if (bytes.length < FOOTER_TRAILER_SIZE || !hasMagicAt(bytes, bytes.length - 4)) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const footerLength = view.getUint32(bytes.length - FOOTER_TRAILER_SIZE, true);
  const footerStart = bytes.length - FOOTER_TRAILER_SIZE - footerLength;
  if (footerStart < headerEnd) {
    return null;
  }

  // A still-downloading prefix can coincidentally end in the magic bytes. Confirm the
  // candidate footer is internally consistent (the body is exactly the segment-count
  // word plus a whole number of index entries) before trusting it; otherwise treat the
  // bytes as ordinary stream content and keep waiting for the real footer.
  const segmentCount = view.getUint32(footerStart, true);
  if (4 + segmentCount * INDEX_ENTRY_SIZE !== footerLength) {
    return null;
  }

  return footerStart;
}

interface SegmentHeaderFields {
  kind: number;
  byteLength: number;
  startTimeMs: number;
  endTimeMs: number;
  firstFrameIndex: number;
  clusterIndex: number;
  containsKeyframe: boolean;
  isInit: boolean;
}

function segmentHeaderSize(formatVersion: number): number {
  return formatVersion < 2 ? LEGACY_SEGMENT_HEADER_SIZE : SEGMENT_HEADER_SIZE;
}

function readSegmentHeader(
  view: DataView,
  offset: number,
  formatVersion: number,
): SegmentHeaderFields {
  const isLegacy = formatVersion < 2;
  const kind = view.getUint8(offset);
  const byteLength = view.getUint32(offset + 1, true);
  const startTimeMs = view.getUint32(offset + 5, true);
  const endTimeMs = isLegacy ? startTimeMs : view.getUint32(offset + 9, true);
  const firstFrameIndex = isLegacy
    ? view.getInt32(offset + 9, true)
    : view.getInt32(offset + 13, true);
  const clusterIndex = isLegacy ? 0 : view.getUint32(offset + 17, true);
  const flags = isLegacy ? view.getUint8(offset + 13) : view.getUint8(offset + 21);
  return {
    kind,
    byteLength,
    startTimeMs,
    endTimeMs,
    firstFrameIndex,
    clusterIndex,
    containsKeyframe: isLegacy ? flags === 1 : Boolean(flags & SEGMENT_FLAG_CONTAINS_KEYFRAME),
    isInit: !isLegacy && Boolean(flags & SEGMENT_FLAG_IS_INIT),
  };
}

function isKnownSegmentKind(kind: number): boolean {
  return kind >= SEGMENT_KIND.frames && kind <= SEGMENT_KIND.cameraChunk;
}

function* walkSegments(
  bytes: Uint8Array,
  start: number,
  end: number,
  formatVersion: number,
): Generator<DecodedSegment> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = segmentHeaderSize(formatVersion);
  let offset = start;
  let sequence = 0;

  while (offset + headerSize <= end) {
    const header = readSegmentHeader(view, offset, formatVersion);
    const payloadStart = offset + headerSize;
    const payloadEnd = payloadStart + header.byteLength;

    // A segment that runs past the known end is a truncated tail — stop and wait.
    if (payloadEnd > end) {
      break;
    }

    // Unknown (future) segment kinds are self-delimiting, so skip them rather than
    // aborting the walk and silently dropping every later segment plus the footer.
    if (!isKnownSegmentKind(header.kind)) {
      offset = payloadEnd;
      sequence += 1;
      continue;
    }

    yield {
      kind: header.kind,
      payload: bytes.subarray(payloadStart, payloadEnd),
      startTimeMs: header.startTimeMs,
      endTimeMs: header.endTimeMs,
      firstFrameIndex: header.firstFrameIndex,
      clusterIndex: header.clusterIndex,
      containsKeyframe: header.containsKeyframe,
      isInit: header.isInit,
      sequence,
    };

    offset = payloadEnd;
    sequence += 1;
  }
}

/**
 * Decoded-stream accumulators shared by the one-shot decoder and the incremental
 * reader. Record arrays are expected in stream (timeline) order; media blobs are
 * pre-assembled and {@link RecordingMediaFragment} metadata carries no bytes.
 */
interface DecodedStreamState {
  meta: RecordingStreamMeta;
  formatVersion: number;
  streamFinalized: boolean;
  hasSegments: boolean;
  maxSegmentTimeMs: number;
  frames: DeltaFrame[];
  slideEvents: SlideEvent[];
  previewEvents: PreviewEvent[];
  previewInitialDocuments: PreviewInitialDocument[];
  previewPatchBatches: PreviewDomPatchBatch[];
  workspaceEvents: WorkspaceRecordingEvent[];
  runtimeEvents: RuntimeRecordingEvent[];
  cursorEvents: CursorRecordingEvent[];
  audioBlob?: Blob;
  cameraBlob?: Blob;
  audioFragments: RecordingMediaFragment[];
  cameraFragments: RecordingMediaFragment[];
  clusterSummaries: RecordingClusterMeta[];
}

/**
 * Builds a {@link Recording} from accumulated stream state. The single source of
 * truth for both `decodeSegments` (whole buffer) and the incremental reader, so a
 * progressively-decoded prefix and a one-shot decode of the same bytes match.
 */
function assembleRecording(state: DecodedStreamState): Recording {
  const { meta, formatVersion, streamFinalized } = state;

  const decodedDuration = Math.max(meta.duration, state.maxSegmentTimeMs);
  const audioStartOffsetMs =
    meta.audioStartOffsetMs ?? state.audioFragments[0]?.startTimeMs ?? undefined;
  const cameraStartOffsetMs =
    meta.cameraStartOffsetMs ?? state.cameraFragments[0]?.startTimeMs ?? undefined;

  const provisionalRecording: Recording = {
    version: meta.version,
    id: meta.id,
    name: meta.name,
    keyframeInterval: meta.keyframeInterval,
    createdAt: meta.createdAt,
    duration: decodedDuration,
    frames: state.frames,
    slideEvents: state.slideEvents.length > 0 ? state.slideEvents : undefined,
    previewEvents: state.previewEvents.length > 0 ? state.previewEvents : undefined,
    previewInitialDocuments:
      state.previewInitialDocuments.length > 0 ? state.previewInitialDocuments : undefined,
    previewPatchBatches:
      state.previewPatchBatches.length > 0 ? state.previewPatchBatches : undefined,
    workspaceEvents: state.workspaceEvents.length > 0 ? state.workspaceEvents : undefined,
    runtimeEvents: state.runtimeEvents.length > 0 ? state.runtimeEvents : undefined,
    cursorEvents: state.cursorEvents.length > 0 ? state.cursorEvents : undefined,
    slides: meta.slides,
    audioBlob: state.audioBlob,
    audioSource: meta.audioSource,
    audioStartOffsetMs,
    cameraBlob: state.cameraBlob,
    cameraSource: meta.cameraSource,
    cameraStartOffsetMs,
    streamFinalized,
    workspaceSnapshot: meta.workspaceSnapshot,
    runtimeSnapshot: meta.runtimeSnapshot,
  };

  const clusters =
    meta.clusters && meta.clusters.length > 0
      ? meta.clusters
          .map((cluster) => ({ ...cluster }))
          .sort((left, right) => left.index - right.index)
      : formatVersion >= 2 && state.hasSegments
        ? [...state.clusterSummaries].sort((left, right) => left.index - right.index)
        : deriveRecordingClusters(provisionalRecording);

  const tracks =
    meta.tracks && meta.tracks.length > 0
      ? meta.tracks.map((track) => ({ ...track }))
      : deriveRecordingTracks(provisionalRecording);

  const mediaFragments =
    state.audioFragments.length > 0 || state.cameraFragments.length > 0
      ? [...state.audioFragments, ...state.cameraFragments].sort(
          (left, right) =>
            left.startTimeMs - right.startTimeMs || left.clusterIndex - right.clusterIndex,
        )
      : deriveRecordingMediaFragments(provisionalRecording, tracks, clusters);

  return normalizeRecordingData({
    ...provisionalRecording,
    tracks: tracks.length > 0 ? tracks : undefined,
    clusters: clusters.length > 0 ? clusters : undefined,
    mediaFragments: mediaFragments.length > 0 ? mediaFragments : undefined,
  });
}

function mergeClusterSummary(
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

function mediaFragmentFromSegment(
  meta: RecordingStreamMeta,
  kind: "audio" | "camera",
  header: Pick<SegmentHeaderFields, "clusterIndex" | "startTimeMs" | "endTimeMs" | "isInit">,
  byteLength: number,
): RecordingMediaFragment {
  return {
    trackId: getTrackId(
      meta.tracks,
      kind,
      kind === "audio" ? DEFAULT_AUDIO_TRACK_ID : DEFAULT_CAMERA_TRACK_ID,
    ),
    clusterIndex: header.clusterIndex,
    startTimeMs: header.startTimeMs,
    endTimeMs: header.endTimeMs,
    byteLength,
    isInit: header.isInit,
  };
}

function decodeSegments(bytes: Uint8Array): Recording {
  const { meta, headerEnd, formatVersion } = parseHeader(bytes);
  const footerStart = findFooterStart(bytes, headerEnd);
  const segmentsEnd = footerStart ?? bytes.length;
  const streamFinalized = footerStart !== null;

  const frames: DeltaFrame[] = [];
  const slideEvents: SlideEvent[] = [];
  const previewEvents: PreviewEvent[] = [];
  const previewInitialDocuments: PreviewInitialDocument[] = [];
  const previewPatchBatches: PreviewDomPatchBatch[] = [];
  const workspaceEvents: WorkspaceRecordingEvent[] = [];
  const runtimeEvents: RuntimeRecordingEvent[] = [];
  const cursorEvents: CursorRecordingEvent[] = [];
  const audioSegments: SequencedMediaSegment[] = [];
  const cameraSegments: SequencedMediaSegment[] = [];
  const clusterMap = new Map<number, RecordingClusterMeta>();
  let hasSegments = false;
  let maxSegmentTimeMs = meta.duration;

  for (const segment of walkSegments(bytes, headerEnd, segmentsEnd, formatVersion)) {
    hasSegments = true;
    maxSegmentTimeMs = Math.max(maxSegmentTimeMs, segment.startTimeMs, segment.endTimeMs);
    mergeClusterSummary(
      clusterMap,
      segment.clusterIndex,
      segment.startTimeMs,
      segment.endTimeMs,
      segment.containsKeyframe,
    );
    switch (segment.kind) {
      case SEGMENT_KIND.frames:
        frames.push(...decodeRecords<DeltaFrame>(segment.payload));
        break;
      case SEGMENT_KIND.slide:
        slideEvents.push(...decodeRecords<SlideEvent>(segment.payload));
        break;
      case SEGMENT_KIND.preview:
        previewEvents.push(...decodeRecords<PreviewEvent>(segment.payload));
        break;
      case SEGMENT_KIND.previewDoc:
        previewInitialDocuments.push(...decodeRecords<PreviewInitialDocument>(segment.payload));
        break;
      case SEGMENT_KIND.previewPatch:
        previewPatchBatches.push(...decodeRecords<PreviewDomPatchBatch>(segment.payload));
        break;
      case SEGMENT_KIND.workspace:
        workspaceEvents.push(...decodeRecords<WorkspaceRecordingEvent>(segment.payload));
        break;
      case SEGMENT_KIND.runtime:
        runtimeEvents.push(...decodeRecords<RuntimeRecordingEvent>(segment.payload));
        break;
      case SEGMENT_KIND.cursor:
        cursorEvents.push(...decodeRecords<CursorRecordingEvent>(segment.payload));
        break;
      case SEGMENT_KIND.audioChunk:
        audioSegments.push({
          trackId: getTrackId(meta.tracks, "audio", DEFAULT_AUDIO_TRACK_ID),
          clusterIndex: segment.clusterIndex,
          startTimeMs: segment.startTimeMs,
          endTimeMs: segment.endTimeMs,
          byteLength: segment.payload.length,
          bytes: segment.payload.slice(),
          isInit: segment.isInit,
          sequence: segment.sequence,
        });
        break;
      case SEGMENT_KIND.cameraChunk:
        cameraSegments.push({
          trackId: getTrackId(meta.tracks, "camera", DEFAULT_CAMERA_TRACK_ID),
          clusterIndex: segment.clusterIndex,
          startTimeMs: segment.startTimeMs,
          endTimeMs: segment.endTimeMs,
          byteLength: segment.payload.length,
          bytes: segment.payload.slice(),
          isInit: segment.isInit,
          sequence: segment.sequence,
        });
        break;
    }
  }

  frames.sort((left, right) => left.timestamp - right.timestamp);
  slideEvents.sort((left, right) => left.timestamp - right.timestamp);
  previewEvents.sort((left, right) => left.timestamp - right.timestamp);
  previewInitialDocuments.sort((left, right) => left.time - right.time);
  previewPatchBatches.sort((left, right) => left.time - right.time);
  workspaceEvents.sort((left, right) => left.timestamp - right.timestamp);
  runtimeEvents.sort((left, right) => left.timestamp - right.timestamp);
  cursorEvents.sort((left, right) => left.timestamp - right.timestamp);

  const sortedAudioSegments = sortMediaSegments(audioSegments);
  const sortedCameraSegments = sortMediaSegments(cameraSegments);

  const audioBlob =
    sortedAudioSegments.length > 0
      ? new Blob(
          [copyToArrayBuffer(concatChunks(sortedAudioSegments.map((segment) => segment.bytes)))],
          { type: meta.audioType || "audio/webm" },
        )
      : undefined;
  const cameraBlob =
    sortedCameraSegments.length > 0
      ? new Blob(
          [copyToArrayBuffer(concatChunks(sortedCameraSegments.map((segment) => segment.bytes)))],
          { type: meta.cameraType || "video/webm" },
        )
      : undefined;

  return assembleRecording({
    meta,
    formatVersion,
    streamFinalized,
    hasSegments,
    maxSegmentTimeMs,
    frames,
    slideEvents,
    previewEvents,
    previewInitialDocuments,
    previewPatchBatches,
    workspaceEvents,
    runtimeEvents,
    cursorEvents,
    audioBlob,
    cameraBlob,
    audioFragments: sortedAudioSegments.map(
      ({ bytes: _bytes, sequence: _sequence, ...fragment }) => fragment,
    ),
    cameraFragments: sortedCameraSegments.map(
      ({ bytes: _bytes, sequence: _sequence, ...fragment }) => fragment,
    ),
    clusterSummaries: Array.from(clusterMap.values()),
  });
}

export function decodeRecordingStream(bytes: Uint8Array): Recording {
  return decodeSegments(bytes);
}

export function decodeRecordingPrefix(bytes: Uint8Array): Recording {
  return decodeSegments(bytes);
}

// ============================================================================
// Incremental streaming reader
//
// Feed network chunks with `push()` and read the current `Recording` with
// `getRecording()`. Only newly-completed segments are decoded on each push (the
// header is parsed once, segment payloads are inflated once), so progressive
// playback cost is O(total bytes) instead of the O(n²) of re-decoding the whole
// prefix every interval. Media blobs grow by reference (`new Blob([prev, next])`)
// rather than being re-concatenated from scratch each time.
//
// Stream bytes are written in timeline (cluster/time) order, so accumulators stay
// sorted by arrival and need no re-sort. Output matches a one-shot
// `decodeRecordingStream` of the same bytes.
// ============================================================================

export interface StreamingRecordingReader {
  /** Appends freshly-downloaded bytes and decodes any whole segments now available. */
  push(bytes: Uint8Array): void;
  /** Current decoded recording, or `null` until the header has fully arrived. */
  getRecording(): Recording | null;
  /** True once the footer has been parsed (the stream is complete). */
  isFinalized(): boolean;
  /** Total number of bytes fed so far. */
  byteLength(): number;
}

const STREAMING_READER_INITIAL_CAPACITY = 64 * 1024;

export function createStreamingRecordingReader(): StreamingRecordingReader {
  let buffer = new Uint8Array(0);
  let length = 0;

  let headerParsed = false;
  let meta: RecordingStreamMeta | null = null;
  let headerEnd = 0;
  let formatVersion = STREAM_FORMAT_VERSION;
  let cursor = 0;
  let finalized = false;

  const frames: DeltaFrame[] = [];
  const slideEvents: SlideEvent[] = [];
  const previewEvents: PreviewEvent[] = [];
  const previewInitialDocuments: PreviewInitialDocument[] = [];
  const previewPatchBatches: PreviewDomPatchBatch[] = [];
  const workspaceEvents: WorkspaceRecordingEvent[] = [];
  const runtimeEvents: RuntimeRecordingEvent[] = [];
  const cursorEvents: CursorRecordingEvent[] = [];
  const audioFragments: RecordingMediaFragment[] = [];
  const cameraFragments: RecordingMediaFragment[] = [];
  const clusterMap = new Map<number, RecordingClusterMeta>();

  let audioBlob: Blob | undefined;
  let cameraBlob: Blob | undefined;
  let segmentCount = 0;
  let maxSegmentTimeMs = 0;

  const grow = (incoming: Uint8Array): void => {
    if (length + incoming.length > buffer.length) {
      let capacity = buffer.length || STREAMING_READER_INITIAL_CAPACITY;
      while (capacity < length + incoming.length) {
        capacity *= 2;
      }
      const next = new Uint8Array(capacity);
      next.set(buffer.subarray(0, length), 0);
      buffer = next;
    }
    buffer.set(incoming, length);
    length += incoming.length;
  };

  const tryParseHeader = (): void => {
    if (headerParsed || length < HEADER_PREFIX_SIZE) return;
    if (!hasMagicAt(buffer, 0)) {
      throw new Error("Invalid SCR3 stream: bad magic number");
    }
    const view = new DataView(buffer.buffer, 0, length);
    const metaLength = view.getUint32(8, true);
    if (metaLength === 0) {
      throw new Error("Invalid SCR3 stream: bad header length");
    }
    const metaEnd = HEADER_PREFIX_SIZE + metaLength;
    if (metaEnd > length) return; // header not fully downloaded yet

    formatVersion = view.getUint16(4, true);
    meta = msgpackDecode(
      inflate(buffer.subarray(HEADER_PREFIX_SIZE, metaEnd)),
    ) as RecordingStreamMeta;
    headerEnd = metaEnd;
    cursor = metaEnd;
    headerParsed = true;
  };

  // Decodes the payload *before* mutating any accumulator so that a throw (a partial
  // footer misparsed as a segment, or genuine corruption) leaves the reader's state and
  // cursor untouched and the parse can be safely retried or rolled back.
  const ingestSegment = (header: SegmentHeaderFields, payload: Uint8Array): void => {
    if (!meta) return;

    let commit: () => void;
    switch (header.kind) {
      case SEGMENT_KIND.frames: {
        const records = decodeRecords<DeltaFrame>(payload);
        commit = () => frames.push(...records);
        break;
      }
      case SEGMENT_KIND.slide: {
        const records = decodeRecords<SlideEvent>(payload);
        commit = () => slideEvents.push(...records);
        break;
      }
      case SEGMENT_KIND.preview: {
        const records = decodeRecords<PreviewEvent>(payload);
        commit = () => previewEvents.push(...records);
        break;
      }
      case SEGMENT_KIND.previewDoc: {
        const records = decodeRecords<PreviewInitialDocument>(payload);
        commit = () => previewInitialDocuments.push(...records);
        break;
      }
      case SEGMENT_KIND.previewPatch: {
        const records = decodeRecords<PreviewDomPatchBatch>(payload);
        commit = () => previewPatchBatches.push(...records);
        break;
      }
      case SEGMENT_KIND.workspace: {
        const records = decodeRecords<WorkspaceRecordingEvent>(payload);
        commit = () => workspaceEvents.push(...records);
        break;
      }
      case SEGMENT_KIND.runtime: {
        const records = decodeRecords<RuntimeRecordingEvent>(payload);
        commit = () => runtimeEvents.push(...records);
        break;
      }
      case SEGMENT_KIND.cursor: {
        const records = decodeRecords<CursorRecordingEvent>(payload);
        commit = () => cursorEvents.push(...records);
        break;
      }
      case SEGMENT_KIND.audioChunk: {
        // Copy out of the growable buffer (it may be reallocated on the next push).
        const chunk = payload.slice();
        const type = meta.audioType || "audio/webm";
        const mediaMeta = meta;
        commit = () => {
          audioBlob = audioBlob
            ? new Blob([audioBlob, chunk], { type })
            : new Blob([chunk], { type });
          audioFragments.push(mediaFragmentFromSegment(mediaMeta, "audio", header, chunk.length));
        };
        break;
      }
      case SEGMENT_KIND.cameraChunk: {
        const chunk = payload.slice();
        const type = meta.cameraType || "video/webm";
        const mediaMeta = meta;
        commit = () => {
          cameraBlob = cameraBlob
            ? new Blob([cameraBlob, chunk], { type })
            : new Blob([chunk], { type });
          cameraFragments.push(mediaFragmentFromSegment(mediaMeta, "camera", header, chunk.length));
        };
        break;
      }
      default:
        commit = () => {};
    }

    segmentCount += 1;
    maxSegmentTimeMs = Math.max(maxSegmentTimeMs, header.startTimeMs, header.endTimeMs);
    mergeClusterSummary(
      clusterMap,
      header.clusterIndex,
      header.startTimeMs,
      header.endTimeMs,
      header.containsKeyframe,
    );
    commit();
  };

  const parseSegments = (): void => {
    if (!headerParsed) return;

    const footerStart = findFooterStart(buffer.subarray(0, length), headerEnd);
    if (footerStart !== null) {
      finalized = true;
      // A confirmed footer that sits behind the cursor means an earlier push parsed
      // footer bytes as a segment — the reader is desynchronized and must not be
      // trusted. Surface it so the caller can fall back to a one-shot decode.
      if (cursor > footerStart) {
        throw new Error("SCR3 streaming reader desynchronized past footer");
      }
    }
    const segmentsEnd = footerStart ?? length;
    const view = new DataView(buffer.buffer, 0, length);
    const headerSize = segmentHeaderSize(formatVersion);

    while (cursor + headerSize <= segmentsEnd) {
      const header = readSegmentHeader(view, cursor, formatVersion);
      const payloadStart = cursor + headerSize;
      const payloadEnd = payloadStart + header.byteLength;

      if (payloadEnd > segmentsEnd) {
        break; // segment not fully downloaded yet
      }
      if (!isKnownSegmentKind(header.kind)) {
        // Until the footer is confirmed these bytes might be a partial footer rather
        // than a real segment, so wait. Once finalized, an unknown kind is a genuine
        // future segment that is safe to skip past.
        if (!finalized) break;
        cursor = payloadEnd;
        continue;
      }

      try {
        ingestSegment(header, buffer.subarray(payloadStart, payloadEnd));
      } catch (error) {
        // Inside the segment region (footer already seen) this is real corruption.
        // Otherwise these are most likely partial-footer bytes that happen to read as
        // a known kind — leave the cursor put and wait for the footer to complete.
        if (finalized) throw error;
        break;
      }
      cursor = payloadEnd;
    }
  };

  return {
    push(bytes) {
      if (bytes.length > 0) {
        grow(bytes);
      }
      tryParseHeader();
      parseSegments();
    },
    getRecording() {
      if (!headerParsed || !meta) return null;
      return assembleRecording({
        meta,
        formatVersion,
        streamFinalized: finalized,
        hasSegments: segmentCount > 0,
        maxSegmentTimeMs: Math.max(meta.duration, maxSegmentTimeMs),
        frames,
        slideEvents,
        previewEvents,
        previewInitialDocuments,
        previewPatchBatches,
        workspaceEvents,
        runtimeEvents,
        cursorEvents,
        audioBlob,
        cameraBlob,
        audioFragments,
        cameraFragments,
        clusterSummaries: Array.from(clusterMap.values()),
      });
    },
    isFinalized() {
      return finalized;
    },
    byteLength() {
      return length;
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

function groupRecordsByCluster<T>(
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

function batchFramesByKeyframe(frames: DeltaFrame[]): DeltaFrame[][] {
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

export async function encodeRecordingToStream(recording: Recording): Promise<Uint8Array> {
  const normalized = normalizeRecordingData(recording);
  const tracks = deriveRecordingTracks(normalized);
  const clusters = deriveRecordingClusters(normalized);
  const audioFragments = await materializeMediaSegments(normalized, "audio", tracks, clusters);
  const cameraFragments = await materializeMediaSegments(normalized, "camera", tracks, clusters);
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
    cameraType: cameraFragments.length > 0 ? cameraTrack?.mimeType || "video/webm" : undefined,
    cameraSource: cameraFragments.length > 0 ? normalized.cameraSource : undefined,
    cameraStartOffsetMs: cameraFragments.length > 0 ? normalized.cameraStartOffsetMs : undefined,
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

  cameraFragments.forEach((fragment, index) => {
    pendingSegments.push({
      clusterIndex: fragment.clusterIndex,
      startTimeMs: fragment.startTimeMs,
      priority: 3,
      write: () =>
        writer.appendCameraChunk(fragment.bytes, {
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
