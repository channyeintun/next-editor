import { decode as msgpackDecode, encode as msgpackEncode } from "@msgpack/msgpack";
import { deflate, inflate } from "pako";
import type { Recording } from "../core/src";
import type { CursorRecordingEvent, RecordingAudioSource } from "../core/src/types";
import type {
  PreviewDomPatchBatch,
  PreviewEvent,
  PreviewInitialDocument,
  SlideEvent,
  Slide,
} from "../core/src/slides";
import type { RuntimeRecordingEvent, RuntimeRecordingSnapshot } from "../types/runtime";
import type { WorkspaceRecordingEvent, WorkspaceRecordingSnapshot } from "../types/workspace";
import type { DeltaFrame } from "../core/src/utils/deltaTypes";
import { isKeyframe } from "../core/src/utils/deltaTypes";
import { normalizeRecordingData } from "../core/src/utils/editorState";

// ============================================================================
// SCR3 — append-only, seekable, range-loadable recording stream container.
//
// A single recording serializes to one self-describing stream. The same byte
// layout is produced whether the stream is built live (segment-by-segment) or
// exported in one shot, so a still-recording prefix is replayable and a
// finalized file is seekable via its footer index.
//
// Layout:
//   Header:  "SCR3" | formatVersion u16 | flags u16 | metaLen u32 | meta bytes
//            (meta bytes = deflate(msgpack(RecordingStreamMeta)))
//   Segment: kind u8 | byteLength u32 | firstTimestampMs u32 |
//            firstFrameIndex i32 | containsKeyframe u8 | payload (byteLength)
//            (payload = deflate(msgpack(records[])); audio chunks are raw bytes)
//   Footer:  segmentCount u32 | index[count] | footerLen u32 | "SCR3"
//            (index entry = kind u8 | byteOffset u32 | firstTs u32 | firstIdx i32)
// ============================================================================

export const STREAM_MAGIC = "SCR3";
const STREAM_MAGIC_BYTES = new Uint8Array([0x53, 0x43, 0x52, 0x33]); // "SCR3"
const STREAM_FORMAT_VERSION = 1;

const FLAG_HAS_AUDIO = 1 << 0;

const HEADER_PREFIX_SIZE = 12; // magic(4) + version(2) + flags(2) + metaLen(4)
const SEGMENT_HEADER_SIZE = 14; // kind(1) + len(4) + ts(4) + idx(4) + keyframe(1)
const INDEX_ENTRY_SIZE = 13; // kind(1) + offset(4) + ts(4) + idx(4)
const FOOTER_TRAILER_SIZE = 8; // footerLen(4) + magic(4)
const U32_MAX = 0xffffffff;

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
} as const;

export type SegmentKind = (typeof SEGMENT_KIND)[keyof typeof SEGMENT_KIND];

/** Recording-level metadata carried in the stream header (everything but the streams). */
export interface RecordingStreamMeta {
  version: 2 | 3;
  id: string;
  name: string;
  keyframeInterval: number;
  createdAt: number;
  duration: number;
  audioType?: string;
  audioSource?: RecordingAudioSource;
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

/**
 * Incremental writer for an SCR3 stream. Drives both the offline exporter and
 * (later) live append: `drainPending` hands out the bytes appended since the
 * previous drain so callers can persist/forward them as they are produced.
 */
export interface StreamingRecordingWriter {
  writeHeader(meta: RecordingStreamMeta): void;
  appendFrameSegment(frames: DeltaFrame[]): void;
  appendEventSegment(kind: SegmentKind, records: ReadonlyArray<unknown>): void;
  appendAudioChunk(chunk: Uint8Array): void;
  finalize(): Uint8Array;
  drainPending(): Uint8Array;
  isFinalized(): boolean;
}

// ----------------------------------------------------------------------------
// Binary helpers
// ----------------------------------------------------------------------------

function clampU32(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value > U32_MAX ? U32_MAX : Math.floor(value);
}

function concatChunks(parts: Uint8Array[], totalLength?: number): Uint8Array<ArrayBuffer> {
  const total = totalLength ?? parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
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
  firstTimestampMs: number,
  firstFrameIndex: number,
  containsKeyframe: boolean,
): Uint8Array {
  const chunk = new Uint8Array(SEGMENT_HEADER_SIZE + payload.length);
  const view = new DataView(chunk.buffer);
  view.setUint8(0, kind);
  view.setUint32(1, payload.length, true);
  view.setUint32(5, clampU32(firstTimestampMs), true);
  view.setInt32(9, firstFrameIndex, true);
  view.setUint8(13, containsKeyframe ? 1 : 0);
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
    view.setUint8(offset, entry.kind);
    view.setUint32(offset + 1, clampU32(entry.byteOffset), true);
    view.setUint32(offset + 5, clampU32(entry.firstTimestampMs), true);
    view.setInt32(offset + 9, entry.firstFrameIndex, true);
    offset += INDEX_ENTRY_SIZE;
  }
  view.setUint32(offset, footerBodySize, true);
  offset += 4;
  chunk.set(STREAM_MAGIC_BYTES, offset);
  return chunk;
}

// ----------------------------------------------------------------------------
// Writer
// ----------------------------------------------------------------------------

export function createStreamingRecordingWriter(): StreamingRecordingWriter {
  const chunks: Uint8Array[] = [];
  const index: SegmentIndexEntry[] = [];
  let length = 0;
  let drainedChunkCount = 0;
  let headerWritten = false;
  let finalized = false;
  let frameCount = 0;

  const pushChunk = (bytes: Uint8Array): void => {
    chunks.push(bytes);
    length += bytes.length;
  };

  const ensureWritable = (): void => {
    if (!headerWritten) throw new Error("SCR3 header not written");
    if (finalized) throw new Error("SCR3 stream already finalized");
  };

  const appendSegment = (
    kind: number,
    payload: Uint8Array,
    firstTimestampMs: number,
    firstFrameIndex: number,
    containsKeyframe: boolean,
  ): void => {
    const byteOffset = length;
    pushChunk(
      buildSegmentChunk(kind, payload, firstTimestampMs, firstFrameIndex, containsKeyframe),
    );
    index.push({ kind, byteOffset, firstTimestampMs, firstFrameIndex });
  };

  return {
    writeHeader(meta) {
      if (headerWritten) throw new Error("SCR3 header already written");
      const flags = meta.audioType ? FLAG_HAS_AUDIO : 0;
      pushChunk(buildHeaderChunk(meta, flags));
      headerWritten = true;
    },
    appendFrameSegment(frames) {
      ensureWritable();
      if (frames.length === 0) return;
      appendSegment(
        SEGMENT_KIND.frames,
        encodeRecords(frames),
        frames[0].timestamp,
        frameCount,
        frames.some(isKeyframe),
      );
      frameCount += frames.length;
    },
    appendEventSegment(kind, records) {
      ensureWritable();
      if (records.length === 0) return;
      appendSegment(kind, encodeRecords(records), readRecordTimestamp(records[0]), -1, false);
    },
    appendAudioChunk(chunk) {
      ensureWritable();
      if (chunk.length === 0) return;
      appendSegment(SEGMENT_KIND.audioChunk, chunk, 0, -1, false);
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

// ----------------------------------------------------------------------------
// Reader
// ----------------------------------------------------------------------------

function hasMagicAt(bytes: Uint8Array, offset: number): boolean {
  return (
    bytes[offset] === STREAM_MAGIC_BYTES[0] &&
    bytes[offset + 1] === STREAM_MAGIC_BYTES[1] &&
    bytes[offset + 2] === STREAM_MAGIC_BYTES[2] &&
    bytes[offset + 3] === STREAM_MAGIC_BYTES[3]
  );
}

/** Returns true when the bytes start with the SCR3 magic. */
export function isStreamingRecording(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && hasMagicAt(bytes, 0);
}

function parseHeader(bytes: Uint8Array): { meta: RecordingStreamMeta; headerEnd: number } {
  if (!isStreamingRecording(bytes)) {
    throw new Error("Invalid SCR3 stream: bad magic number");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLength = view.getUint32(8, true);
  const metaStart = HEADER_PREFIX_SIZE;
  const metaEnd = metaStart + metaLength;
  if (metaLength === 0 || metaEnd > bytes.length) {
    throw new Error("Invalid SCR3 stream: bad header length");
  }
  const meta = msgpackDecode(inflate(bytes.subarray(metaStart, metaEnd))) as RecordingStreamMeta;
  return { meta, headerEnd: metaEnd };
}

function findSegmentsEnd(bytes: Uint8Array, headerEnd: number): number {
  if (bytes.length < FOOTER_TRAILER_SIZE || !hasMagicAt(bytes, bytes.length - 4)) {
    return bytes.length;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const footerLength = view.getUint32(bytes.length - FOOTER_TRAILER_SIZE, true);
  const footerStart = bytes.length - FOOTER_TRAILER_SIZE - footerLength;
  return footerStart >= headerEnd ? footerStart : bytes.length;
}

interface DecodedSegment {
  kind: number;
  payload: Uint8Array;
}

function* walkSegments(bytes: Uint8Array, start: number, end: number): Generator<DecodedSegment> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = start;
  while (offset + SEGMENT_HEADER_SIZE <= end) {
    const kind = view.getUint8(offset);
    const byteLength = view.getUint32(offset + 1, true);
    const payloadStart = offset + SEGMENT_HEADER_SIZE;
    const payloadEnd = payloadStart + byteLength;
    if (kind > SEGMENT_KIND.audioChunk || payloadEnd > end) {
      break; // unknown kind or truncated tail
    }
    yield { kind, payload: bytes.subarray(payloadStart, payloadEnd) };
    offset = payloadEnd;
  }
}

function decodeSegments(bytes: Uint8Array): Recording {
  const { meta, headerEnd } = parseHeader(bytes);
  const segmentsEnd = findSegmentsEnd(bytes, headerEnd);

  const frames: DeltaFrame[] = [];
  const slideEvents: SlideEvent[] = [];
  const previewEvents: PreviewEvent[] = [];
  const previewInitialDocuments: PreviewInitialDocument[] = [];
  const previewPatchBatches: PreviewDomPatchBatch[] = [];
  const workspaceEvents: WorkspaceRecordingEvent[] = [];
  const runtimeEvents: RuntimeRecordingEvent[] = [];
  const cursorEvents: CursorRecordingEvent[] = [];
  const audioChunks: Uint8Array[] = [];

  for (const segment of walkSegments(bytes, headerEnd, segmentsEnd)) {
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
        audioChunks.push(segment.payload.slice());
        break;
    }
  }

  const audioBlob =
    audioChunks.length > 0
      ? new Blob([concatChunks(audioChunks)], { type: meta.audioType || "audio/webm" })
      : undefined;

  const recording: Recording = {
    version: meta.version,
    id: meta.id,
    name: meta.name,
    keyframeInterval: meta.keyframeInterval,
    createdAt: meta.createdAt,
    duration: meta.duration,
    frames,
    slideEvents: slideEvents.length > 0 ? slideEvents : undefined,
    previewEvents: previewEvents.length > 0 ? previewEvents : undefined,
    previewInitialDocuments:
      previewInitialDocuments.length > 0 ? previewInitialDocuments : undefined,
    previewPatchBatches: previewPatchBatches.length > 0 ? previewPatchBatches : undefined,
    workspaceEvents: workspaceEvents.length > 0 ? workspaceEvents : undefined,
    runtimeEvents: runtimeEvents.length > 0 ? runtimeEvents : undefined,
    cursorEvents: cursorEvents.length > 0 ? cursorEvents : undefined,
    slides: meta.slides,
    audioBlob,
    audioSource: meta.audioSource,
    workspaceSnapshot: meta.workspaceSnapshot,
    runtimeSnapshot: meta.runtimeSnapshot,
  };

  return normalizeRecordingData(recording);
}

/** Decodes a complete (finalized) SCR3 stream into a Recording. */
export function decodeRecordingStream(bytes: Uint8Array): Recording {
  return decodeSegments(bytes);
}

/**
 * Decodes a partial or still-writing SCR3 stream into a Recording. Tolerates a
 * missing footer and a truncated trailing segment by replaying every complete
 * segment captured so far.
 */
export function decodeRecordingPrefix(bytes: Uint8Array): Recording {
  return decodeSegments(bytes);
}

// ----------------------------------------------------------------------------
// Offline encode (whole recording -> finalized stream)
// ----------------------------------------------------------------------------

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
      reject(new Error("Failed to read audio blob as ArrayBuffer"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read audio blob"));
    reader.readAsArrayBuffer(blob);
  });
}

async function extractAudioBytes(
  recording: Recording,
): Promise<{ audioBytes: Uint8Array | null; audioType: string }> {
  const blob = recording.audioBlob;
  if (blob instanceof Blob) {
    const buffer = await readBlobAsArrayBuffer(blob);
    return { audioBytes: new Uint8Array(buffer), audioType: blob.type || "audio/webm" };
  }
  return { audioBytes: null, audioType: "audio/webm" };
}

/** Splits the compressed frame array into batches that each start at a keyframe. */
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

/** Encodes a Recording into a complete, finalized SCR3 stream. */
export async function encodeRecordingToStream(recording: Recording): Promise<Uint8Array> {
  const normalized = normalizeRecordingData(recording);
  const { audioBytes, audioType } = await extractAudioBytes(normalized);
  const writer = createStreamingRecordingWriter();

  writer.writeHeader({
    version: normalized.version,
    id: normalized.id,
    name: normalized.name,
    keyframeInterval: normalized.keyframeInterval,
    createdAt: normalized.createdAt,
    duration: normalized.duration,
    audioType: audioBytes ? audioType : undefined,
    audioSource: normalized.audioSource,
    slides: normalized.slides,
    workspaceSnapshot: normalized.workspaceSnapshot,
    runtimeSnapshot: normalized.runtimeSnapshot,
  });

  for (const batch of batchFramesByKeyframe(normalized.frames)) {
    writer.appendFrameSegment(batch);
  }

  if (normalized.slideEvents?.length) {
    writer.appendEventSegment(SEGMENT_KIND.slide, normalized.slideEvents);
  }
  if (normalized.previewEvents?.length) {
    writer.appendEventSegment(SEGMENT_KIND.preview, normalized.previewEvents);
  }
  if (normalized.previewInitialDocuments?.length) {
    writer.appendEventSegment(SEGMENT_KIND.previewDoc, normalized.previewInitialDocuments);
  }
  if (normalized.previewPatchBatches?.length) {
    writer.appendEventSegment(SEGMENT_KIND.previewPatch, normalized.previewPatchBatches);
  }
  if (normalized.workspaceEvents?.length) {
    writer.appendEventSegment(SEGMENT_KIND.workspace, normalized.workspaceEvents);
  }
  if (normalized.runtimeEvents?.length) {
    writer.appendEventSegment(SEGMENT_KIND.runtime, normalized.runtimeEvents);
  }
  if (normalized.cursorEvents?.length) {
    writer.appendEventSegment(SEGMENT_KIND.cursor, normalized.cursorEvents);
  }

  if (audioBytes) {
    writer.appendAudioChunk(audioBytes);
  }

  return writer.finalize();
}
