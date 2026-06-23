import { decode as msgpackDecode } from "@msgpack/msgpack";
import { unzlibSync } from "fflate";
import type { Recording } from "../../core/src";
import type {
  CursorRecordingEvent,
  RecordingClusterMeta,
  RecordingMediaFragment,
} from "../../core/src/types";
import type {
  PreviewDomPatchBatch,
  PreviewEvent,
  PreviewInitialDocument,
  SlideEvent,
} from "../../core/src/slides";
import type { DeltaFrame } from "../../core/src/utils/deltaTypes";
import { normalizeRecordingData } from "../../core/src/utils/editorState";
import type { RuntimeRecordingEvent } from "../../types/runtime";
import type { WorkspaceRecordingEvent } from "../../types/workspace";
import {
  concatChunks,
  copyToArrayBuffer,
  decodeRecords,
  DEFAULT_AUDIO_TRACK_ID,
  DEFAULT_CAMERA_TRACK_ID,
  findFooterStart,
  hasMagicAt,
  HEADER_PREFIX_SIZE,
  isKnownSegmentKind,
  parseHeader,
  readSegmentHeader,
  SEGMENT_KIND,
  segmentHeaderSize,
  STREAM_FORMAT_VERSION,
  type MaterializedMediaSegment,
  type RecordingStreamMeta,
  type SegmentHeaderFields,
} from "./format";
import {
  deriveRecordingClusters,
  deriveRecordingMediaFragments,
  deriveRecordingTracks,
  getTrackId,
  mergeClusterSummary,
} from "./clusters";

// ============================================================================
// Decoding: turn SCR3 bytes into a `Recording`.
//
// `decodeRecordingStream` decodes a whole buffer in one shot.
// `createStreamingRecordingReader` decodes incrementally as bytes arrive, decoding
// only newly-completed segments per push. Both feed `assembleRecording`, so a
// progressively-decoded prefix and a one-shot decode of the same bytes match.
// ============================================================================

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

function sortMediaSegments<T extends { startTimeMs: number; sequence: number }>(
  segments: T[],
): T[] {
  return segments.sort(
    (left, right) => left.startTimeMs - right.startTimeMs || left.sequence - right.sequence,
  );
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
  audioFragments: RecordingMediaFragment[];
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
  // Camera bytes never live in the stream; its offset comes from meta alone.
  const cameraStartOffsetMs = meta.cameraStartOffsetMs ?? undefined;

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
    // Camera is always external — the stream carries only the reference/metadata, never bytes.
    cameraSource: meta.cameraSource,
    cameraStartOffsetMs,
    cameraFile: meta.cameraFile,
    cameraUrl: meta.cameraUrl,
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
    state.audioFragments.length > 0
      ? [...state.audioFragments].sort(
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

  const audioBlob =
    sortedAudioSegments.length > 0
      ? new Blob(
          [copyToArrayBuffer(concatChunks(sortedAudioSegments.map((segment) => segment.bytes)))],
          { type: meta.audioType || "audio/webm" },
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
    audioFragments: sortedAudioSegments.map(
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
  const clusterMap = new Map<number, RecordingClusterMeta>();

  let audioBlob: Blob | undefined;
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
      unzlibSync(buffer.subarray(HEADER_PREFIX_SIZE, metaEnd)),
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
        audioFragments,
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
