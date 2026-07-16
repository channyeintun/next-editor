import { decode as msgpackDecode, encode as msgpackEncode } from "@msgpack/msgpack";
import { Unzlib, zlibSync } from "fflate";
import type {
  CaptionTrack,
  RecordingAudioSource,
  RecordingCameraSource,
  RecordingClusterMeta,
  RecordingTrackMeta,
} from "../../core/src/types";
import type { Slide } from "../../core/src/slides";
import type { RuntimeRecordingSnapshot } from "../../types/runtime";
import type { WorkspaceRecordingSnapshot } from "../../types/workspace";

// ============================================================================
// SCR3 — append-only, seekable, range-loadable recording stream container.
//
// This module is the single source of truth for the on-wire byte layout: every
// constant, struct size, flag, and field-level read/write helper lives here.
// `encode.ts` and `decode.ts` build the higher-level writer/reader on top of
// these primitives, so a change to the byte layout only needs to touch one file.
//
// A single recording serializes to one self-describing stream. The same byte
// layout is produced whether the stream is built live (segment-by-segment) or
// exported in one shot, so a still-recording prefix is replayable and a
// finalized file is seekable via its footer index.
//
// Three independent "version" numbers exist; do not conflate them:
//   * STREAM_MAGIC ("SCR3")     — container family marker (the file magic).
//   * STREAM_FORMAT_VERSION (2) — on-wire byte layout of the segment headers.
//                                 The only supported layout; older layouts are
//                                 rejected (no legacy compatibility).
//   * meta.version (4)          — the Recording *schema* version carried inside
//                                 the metadata, unrelated to the byte layout.
//
// Layout:
//   Header:  "SCR3" | formatVersion u16 | flags u16 | metaLen u32 | meta bytes
//            (meta bytes = deflate(msgpack(RecordingStreamMeta)))
//   Segment: kind u8 | byteLength u32 | startTimeMs u32 | endTimeMs u32 |
//            firstFrameIndex i32 | clusterIndex u32 | flags u8 | payload
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
export const STREAM_FORMAT_VERSION = 2;

export const FLAG_HAS_AUDIO = 1 << 0;
export const FLAG_HAS_CAMERA = 1 << 1;
const SEGMENT_FLAG_CONTAINS_KEYFRAME = 1 << 0;
const SEGMENT_FLAG_IS_INIT = 1 << 1;

export const HEADER_PREFIX_SIZE = 12;
export const SEGMENT_HEADER_SIZE = 22;
const INDEX_ENTRY_SIZE = 13;
const FOOTER_TRAILER_SIZE = 8;
const U32_MAX = 0xffffffff;
export const DEFAULT_AUDIO_TRACK_ID = "audio";
export const DEFAULT_CAMERA_TRACK_ID = "camera";
export const MAX_STREAM_BYTES = 256 * 1024 * 1024;
export const MAX_COMPRESSED_META_BYTES = 4 * 1024 * 1024;
export const MAX_INFLATED_META_BYTES = 8 * 1024 * 1024;
export const MAX_COMPRESSED_SEGMENT_BYTES = 32 * 1024 * 1024;
export const MAX_INFLATED_SEGMENT_BYTES = 64 * 1024 * 1024;
export const MAX_DECODED_RECORDS = 1_000_000;

export const SEGMENT_KIND = {
  frames: 0,
  slide: 1,
  preview: 2,
  previewDoc: 3,
  previewPatch: 4,
  workspace: 5,
  runtime: 6,
  cursor: 7,
  whiteboard: 8,
  chat: 9,
  /** Authoritative metadata written immediately before the footer by live streams. */
  finalMeta: 10,
  // Media is never stored inline in the stream — audio as a sibling file referenced by
  // `audioFile`/`audioUrl`, camera as a sibling video. 11+ are free for future segment kinds.
} as const;

export type SegmentKind = (typeof SEGMENT_KIND)[keyof typeof SEGMENT_KIND];

/**
 * Canonical mapping between Recording/RecordingSession event arrays and SCR3
 * segment kinds. Both the one-shot exporter and live bridge iterate this table,
 * so adding a track cannot silently update only one encoding path.
 */
export const RECORDING_EVENT_SEGMENTS = [
  { kind: SEGMENT_KIND.slide, key: "slideEvents" },
  { kind: SEGMENT_KIND.preview, key: "previewEvents" },
  { kind: SEGMENT_KIND.previewDoc, key: "previewInitialDocuments" },
  { kind: SEGMENT_KIND.previewPatch, key: "previewPatchBatches" },
  { kind: SEGMENT_KIND.workspace, key: "workspaceEvents" },
  { kind: SEGMENT_KIND.runtime, key: "runtimeEvents" },
  { kind: SEGMENT_KIND.cursor, key: "cursorEvents" },
  { kind: SEGMENT_KIND.whiteboard, key: "whiteboardEvents" },
  { kind: SEGMENT_KIND.chat, key: "chatEvents" },
] as const;

export type RecordingEventSegmentKey = (typeof RECORDING_EVENT_SEGMENTS)[number]["key"];

export interface RecordingStreamMeta {
  version: 4;
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
  /** Sibling audio filename when audio bytes live outside the stream (see {@link Recording.audioFile}). */
  audioFile?: string;
  /** Resolved/absolute URL for external audio, when known at encode time. */
  audioUrl?: string;
  cameraType?: string;
  cameraSource?: RecordingCameraSource;
  cameraStartOffsetMs?: number;
  /** Sibling video filename when camera bytes live outside the stream (see {@link Recording.cameraFile}). */
  cameraFile?: string;
  /** Resolved/absolute URL for an external camera video, when known at encode time. */
  cameraUrl?: string;
  captions?: CaptionTrack[];
  captionFiles?: string[];
  slides?: Slide[];
  workspaceSnapshot?: WorkspaceRecordingSnapshot;
  runtimeSnapshot?: RuntimeRecordingSnapshot;
}

export interface SegmentIndexEntry {
  kind: number;
  byteOffset: number;
  firstTimestampMs: number;
  firstFrameIndex: number;
}

export interface SegmentHeaderFields {
  kind: number;
  byteLength: number;
  startTimeMs: number;
  endTimeMs: number;
  firstFrameIndex: number;
  clusterIndex: number;
  containsKeyframe: boolean;
  isInit: boolean;
}

// ----------------------------------------------------------------------------
// Generic byte / record helpers
// ----------------------------------------------------------------------------

export function clampU32(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value > U32_MAX ? U32_MAX : Math.floor(value);
}

export function concatChunks(parts: Uint8Array[], totalLength?: number): Uint8Array {
  const total = totalLength ?? parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function encodeRecords(records: ReadonlyArray<unknown>): Uint8Array {
  return zlibSync(msgpackEncode(records, { ignoreUndefined: true }));
}

function boundedUnzlib(payload: Uint8Array, maxBytes: number, label: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflater = new Unzlib((chunk) => {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new Error(`Invalid SCR3 stream: ${label} exceeds the decoded size limit`);
    }
    chunks.push(chunk);
  });
  inflater.push(payload, true);
  return concatChunks(chunks, total);
}

export function decodeRecords<T>(payload: Uint8Array): T[] {
  if (payload.byteLength > MAX_COMPRESSED_SEGMENT_BYTES) {
    throw new Error("Invalid SCR3 stream: segment exceeds the compressed size limit");
  }
  const decoded = msgpackDecode(boundedUnzlib(payload, MAX_INFLATED_SEGMENT_BYTES, "segment"));
  if (!Array.isArray(decoded)) return [];
  if (decoded.length > MAX_DECODED_RECORDS) {
    throw new Error("Invalid SCR3 stream: segment contains too many records");
  }
  return decoded as T[];
}

export function readRecordTimestamp(record: unknown): number {
  if (record && typeof record === "object") {
    const value = record as { timestamp?: unknown; time?: unknown };
    if (typeof value.timestamp === "number") return value.timestamp;
    if (typeof value.time === "number") return value.time;
  }
  return 0;
}

export function readLastRecordTimestamp(records: ReadonlyArray<unknown>): number {
  return records.length > 0 ? readRecordTimestamp(records[records.length - 1]) : 0;
}

// ----------------------------------------------------------------------------
// Header / segment / footer primitives (the byte layout itself)
// ----------------------------------------------------------------------------

export function buildHeaderChunk(meta: RecordingStreamMeta, flags: number): Uint8Array {
  const metaBytes = zlibSync(msgpackEncode(meta, { ignoreUndefined: true }));
  const chunk = new Uint8Array(HEADER_PREFIX_SIZE + metaBytes.length);
  const view = new DataView(chunk.buffer);
  chunk.set(STREAM_MAGIC_BYTES, 0);
  view.setUint16(4, STREAM_FORMAT_VERSION, true);
  view.setUint16(6, flags, true);
  view.setUint32(8, metaBytes.length, true);
  chunk.set(metaBytes, HEADER_PREFIX_SIZE);
  return chunk;
}

export function buildSegmentChunk(
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

export function buildFooterChunk(index: SegmentIndexEntry[]): Uint8Array {
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

export function hasMagicAt(bytes: Uint8Array, offset: number): boolean {
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

export function parseHeader(bytes: Uint8Array): {
  meta: RecordingStreamMeta;
  headerEnd: number;
} {
  if (!isStreamingRecording(bytes)) {
    throw new Error("Invalid SCR3 stream: bad magic number");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const formatVersion = view.getUint16(4, true);
  if (formatVersion !== STREAM_FORMAT_VERSION) {
    throw new Error(`Unsupported SCR3 format version: ${formatVersion}`);
  }
  const metaLength = view.getUint32(8, true);
  const metaStart = HEADER_PREFIX_SIZE;
  const metaEnd = metaStart + metaLength;
  if (metaLength === 0 || metaLength > MAX_COMPRESSED_META_BYTES || metaEnd > bytes.length) {
    throw new Error("Invalid SCR3 stream: bad header length");
  }
  const meta = msgpackDecode(
    boundedUnzlib(bytes.subarray(metaStart, metaEnd), MAX_INFLATED_META_BYTES, "header"),
  ) as RecordingStreamMeta;
  return { meta, headerEnd: metaEnd };
}

export function findFooterStart(bytes: Uint8Array, headerEnd: number): number | null {
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

export function readSegmentHeader(view: DataView, offset: number): SegmentHeaderFields {
  const kind = view.getUint8(offset);
  const byteLength = view.getUint32(offset + 1, true);
  const startTimeMs = view.getUint32(offset + 5, true);
  const endTimeMs = view.getUint32(offset + 9, true);
  const firstFrameIndex = view.getInt32(offset + 13, true);
  const clusterIndex = view.getUint32(offset + 17, true);
  const flags = view.getUint8(offset + 21);
  return {
    kind,
    byteLength,
    startTimeMs,
    endTimeMs,
    firstFrameIndex,
    clusterIndex,
    containsKeyframe: Boolean(flags & SEGMENT_FLAG_CONTAINS_KEYFRAME),
    isInit: Boolean(flags & SEGMENT_FLAG_IS_INIT),
  };
}

export function isKnownSegmentKind(kind: number): boolean {
  return kind >= SEGMENT_KIND.frames && kind <= SEGMENT_KIND.finalMeta;
}

// ----------------------------------------------------------------------------
// External camera video MIME <-> filename extension helpers
// ----------------------------------------------------------------------------

const CAMERA_MIME_BY_EXT: Record<string, string> = {
  webm: "video/webm",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

/** Best-effort camera MIME type inferred from a sibling video filename's extension. */
export function cameraMimeFromFilename(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext ? CAMERA_MIME_BY_EXT[ext] : undefined;
}

/** Sibling video file extension (no dot) for a camera blob's MIME type; defaults to `webm`. */
export function cameraExtensionFromMime(mimeType: string | undefined): string {
  if (mimeType) {
    const base = mimeType.split(";")[0].trim().toLowerCase();
    for (const [ext, mime] of Object.entries(CAMERA_MIME_BY_EXT)) {
      if (mime === base) return ext;
    }
  }
  return "webm";
}

// ----------------------------------------------------------------------------
// External audio MIME <-> filename extension helpers
// ----------------------------------------------------------------------------

// `weba` (not `webm`) for audio/webm so a sibling audio file never collides with the
// sibling camera video (`<name>.webm`) exported next to the same `.ne`.
const AUDIO_MIME_BY_EXT: Record<string, string> = {
  weba: "audio/webm",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

/** Best-effort audio MIME type inferred from a sibling audio filename's extension. */
export function audioMimeFromFilename(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext ? AUDIO_MIME_BY_EXT[ext] : undefined;
}

/** Sibling audio file extension (no dot) for an audio blob's MIME type; defaults to `weba`. */
export function audioExtensionFromMime(mimeType: string | undefined): string {
  if (mimeType) {
    const base = mimeType.split(";")[0].trim().toLowerCase();
    for (const [ext, mime] of Object.entries(AUDIO_MIME_BY_EXT)) {
      if (mime === base) return ext;
    }
  }
  return "weba";
}
