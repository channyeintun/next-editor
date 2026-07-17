import type { Recording } from "../../core/src";
import type { CursorRecordingEvent, RecordingClusterMeta } from "../../core/src/types";
import type {
  PreviewDomPatchBatch,
  PreviewEvent,
  PreviewInitialDocument,
  SlideEvent,
} from "../../core/src/slides";
import type { DeltaFrame } from "../../core/src/utils/deltaTypes";
import { normalizeDeltaFrame, normalizeRecordingData } from "../../core/src/utils/editorState";
import type { RuntimeRecordingEvent } from "../../types/runtime";
import type { WorkspaceRecordingEvent } from "../../types/workspace";
import type { WhiteboardEvent } from "../../core/src/whiteboard";
import type { ChatRecordingEvent } from "../../types/chat";
import {
  decodeRecords,
  findFooterStart,
  hasMagicAt,
  HEADER_PREFIX_SIZE,
  isKnownSegmentKind,
  parseHeader,
  readSegmentHeader,
  SEGMENT_HEADER_SIZE,
  SEGMENT_KIND,
  STREAM_FORMAT_VERSION,
  MAX_COMPRESSED_META_BYTES,
  MAX_COMPRESSED_SEGMENT_BYTES,
  MAX_DECODED_RECORDS,
  MAX_STREAM_BYTES,
  type RecordingStreamMeta,
  type SegmentHeaderFields,
} from "./format";
import {
  deriveRecordingClusters,
  deriveRecordingMediaFragments,
  deriveRecordingTracks,
  mergeClusterSummary,
} from "./clusters";
import { hydrateFramePreviewContent } from "./framePreviewContentDedup";
import { createPreviewAddNodeHydrator } from "./previewPatchDedup";
import { createWorkspaceEventContentHydrator } from "./workspaceEventDedup";
import { recordPerformanceMetric, startPerformanceSpan } from "../../utils/performanceMetrics";

// ============================================================================
// Decoding: turn SCR3 bytes into a `Recording`.
//
// `decodeRecordingStream` decodes a whole buffer in one shot.
// `createStreamingRecordingReader` decodes incrementally as bytes arrive, decoding
// only newly-completed segments per push. Both feed `assembleRecording`, so a
// progressively-decoded prefix and a one-shot decode of the same bytes match.
// ============================================================================

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

function* walkSegments(bytes: Uint8Array, start: number, end: number): Generator<DecodedSegment> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = start;
  let sequence = 0;

  while (offset + SEGMENT_HEADER_SIZE <= end) {
    const header = readSegmentHeader(view, offset);
    const payloadStart = offset + SEGMENT_HEADER_SIZE;
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
 * reader. Record arrays are expected in stream (timeline) order. Media bytes never
 * live in the stream — audio/camera are external files referenced from the header.
 */
interface DecodedStreamState {
  meta: RecordingStreamMeta;
  streamFinalized: boolean;
  /**
   * True when frames were already normalized record-by-record as they were decoded
   * (the incremental reader). Skips the whole-recording `normalizeRecordingData`
   * pass, which deep-clones every frame and is O(n) per call — quadratic when run
   * on every progressive-decode interval of a growing stream.
   */
  prenormalized?: boolean;
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
  whiteboardEvents: WhiteboardEvent[];
  chatEvents: ChatRecordingEvent[];
  clusterSummaries: RecordingClusterMeta[];
}

function mergeFinalMetadata(
  current: RecordingStreamMeta,
  payload: Uint8Array,
): RecordingStreamMeta {
  const records = decodeRecords<RecordingStreamMeta>(payload);
  const candidate = records[records.length - 1];

  if (
    !candidate ||
    candidate.version !== 4 ||
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.createdAt !== "number" ||
    !Number.isFinite(candidate.createdAt) ||
    typeof candidate.duration !== "number" ||
    !Number.isFinite(candidate.duration) ||
    candidate.duration < 0
  ) {
    throw new Error("Invalid SCR3 stream: malformed final metadata");
  }

  return { ...current, ...candidate };
}

/**
 * Builds a {@link Recording} from accumulated stream state. The single source of
 * truth for both `decodeSegments` (whole buffer) and the incremental reader, so a
 * progressively-decoded prefix and a one-shot decode of the same bytes match.
 */
function assembleRecording(state: DecodedStreamState): Recording {
  const { meta, streamFinalized } = state;

  const decodedDuration = Math.max(meta.duration, state.maxSegmentTimeMs);
  // Media bytes never live in the stream; audio/camera offsets come from meta alone.
  const audioStartOffsetMs = meta.audioStartOffsetMs ?? undefined;
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
    whiteboardEvents: state.whiteboardEvents.length > 0 ? state.whiteboardEvents : undefined,
    chatEvents: state.chatEvents.length > 0 ? state.chatEvents : undefined,
    captions: meta.captions,
    captionFiles: meta.captionFiles,
    slides: meta.slides,
    audioSource: meta.audioSource,
    audioStartOffsetMs,
    // Audio may live outside the stream — the header then carries only the reference.
    audioFile: meta.audioFile,
    audioUrl: meta.audioUrl,
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
      : state.hasSegments
        ? [...state.clusterSummaries].sort((left, right) => left.index - right.index)
        : deriveRecordingClusters(provisionalRecording);

  const tracks =
    meta.tracks && meta.tracks.length > 0
      ? meta.tracks.map((track) => ({ ...track }))
      : deriveRecordingTracks(provisionalRecording);

  const mediaFragments = deriveRecordingMediaFragments(provisionalRecording, tracks, clusters);

  const assembled: Recording = {
    ...provisionalRecording,
    tracks: tracks.length > 0 ? tracks : undefined,
    clusters: clusters.length > 0 ? clusters : undefined,
    mediaFragments: mediaFragments.length > 0 ? mediaFragments : undefined,
  };

  return state.prenormalized ? assembled : normalizeRecordingData(assembled);
}

function decodeSegments(bytes: Uint8Array): Recording {
  const parsedHeader = parseHeader(bytes);
  let meta = parsedHeader.meta;
  const { headerEnd } = parsedHeader;
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
  const whiteboardEvents: WhiteboardEvent[] = [];
  const chatEvents: ChatRecordingEvent[] = [];
  const clusterMap = new Map<number, RecordingClusterMeta>();
  let hasSegments = false;
  let maxSegmentTimeMs = meta.duration;
  // Stream order matches encode order, so carrying deduped file contents forward
  // here mirrors the stripper's state exactly (see workspaceEventDedup.ts).
  const hydrateWorkspaceEvents = createWorkspaceEventContentHydrator();
  // Same contract for repeated rrweb added-node payloads: hydration must run in
  // stream order (before the time re-sort below) — see previewPatchDedup.ts.
  const hydratePreviewPatchBatches = createPreviewAddNodeHydrator();

  for (const segment of walkSegments(bytes, headerEnd, segmentsEnd)) {
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
        // Per-segment marker resolution — self-contained, no cross-segment carry
        // (see framePreviewContentDedup.ts).
        frames.push(...hydrateFramePreviewContent(decodeRecords<DeltaFrame>(segment.payload)));
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
        previewPatchBatches.push(
          ...hydratePreviewPatchBatches(decodeRecords<PreviewDomPatchBatch>(segment.payload)),
        );
        break;
      case SEGMENT_KIND.workspace:
        workspaceEvents.push(
          ...hydrateWorkspaceEvents(decodeRecords<WorkspaceRecordingEvent>(segment.payload)),
        );
        break;
      case SEGMENT_KIND.runtime:
        runtimeEvents.push(...decodeRecords<RuntimeRecordingEvent>(segment.payload));
        break;
      case SEGMENT_KIND.cursor:
        cursorEvents.push(...decodeRecords<CursorRecordingEvent>(segment.payload));
        break;
      case SEGMENT_KIND.whiteboard:
        whiteboardEvents.push(...decodeRecords<WhiteboardEvent>(segment.payload));
        break;
      case SEGMENT_KIND.chat:
        chatEvents.push(...decodeRecords<ChatRecordingEvent>(segment.payload));
        break;
      case SEGMENT_KIND.finalMeta:
        meta = mergeFinalMetadata(meta, segment.payload);
        break;
    }
    const decodedRecordCount =
      frames.length +
      slideEvents.length +
      previewEvents.length +
      previewInitialDocuments.length +
      previewPatchBatches.length +
      workspaceEvents.length +
      runtimeEvents.length +
      cursorEvents.length +
      whiteboardEvents.length +
      chatEvents.length;
    if (decodedRecordCount > MAX_DECODED_RECORDS) {
      throw new Error("Invalid SCR3 stream: recording contains too many records");
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
  whiteboardEvents.sort((left, right) => left.timestamp - right.timestamp);
  chatEvents.sort((left, right) => left.timestamp - right.timestamp);

  return assembleRecording({
    meta,
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
    whiteboardEvents,
    chatEvents,
    clusterSummaries: Array.from(clusterMap.values()),
  });
}

/**
 * Decodes a whole SCR3 buffer — or any prefix of one — into a `Recording`. A prefix
 * (in-progress footer, truncated trailing segment) decodes tolerantly with
 * `streamFinalized: false`, so callers can progressively decode a growing download.
 */
export function decodeRecordingStream(bytes: Uint8Array): Recording {
  if (bytes.byteLength > MAX_STREAM_BYTES) {
    throw new Error("Invalid SCR3 stream: recording exceeds the size limit");
  }
  return decodeSegments(bytes);
}

// ============================================================================
// Incremental streaming reader
//
// Feed network chunks with `push()`, append newly decoded records from `readDelta()`,
// and construct a complete `Recording` with `getRecording()` only when explicitly
// needed. Completed compressed input is discarded after each push, the header is
// parsed once, and segment payloads are inflated once. Frames are normalized once at
// ingest, and media bytes never live in the stream (audio/camera are external files
// referenced from the header).
//
// Stream bytes are written in timeline (cluster/time) order, so accumulators stay
// sorted by arrival and need no re-sort. Output matches a one-shot
// `decodeRecordingStream` of the same bytes.
// ============================================================================

export interface StreamingRecordingReader {
  /** Appends freshly-downloaded bytes and decodes any whole segments now available. */
  push(bytes: Uint8Array): void;
  /**
   * Returns only records decoded since the previous call. The cursor is monotonic
   * and lets downstream consumers ignore a duplicate delivery without comparing
   * the accumulated recording arrays.
   */
  readDelta(): StreamingRecordingDelta | null;
  /** Current decoded recording, or `null` until the header has fully arrived. */
  getRecording(): Recording | null;
  /** True once the footer has been parsed (the stream is complete). */
  isFinalized(): boolean;
  /** Total number of bytes fed so far. */
  byteLength(): number;
  /** Compressed bytes still needed to finish the current header/segment/footer. */
  retainedByteLength(): number;
  /** Current backing-buffer capacity, exposed for bounded-memory regression tests. */
  retainedCapacity(): number;
}

export interface StreamingRecordingDelta {
  cursor: number;
  recordingId: string;
  duration: number;
  streamFinalized: boolean;
  newFrames: DeltaFrame[];
  newSlideEvents: SlideEvent[];
  newPreviewEvents: PreviewEvent[];
  newPreviewInitialDocuments: PreviewInitialDocument[];
  newPreviewPatchBatches: PreviewDomPatchBatch[];
  newWorkspaceEvents: WorkspaceRecordingEvent[];
  newRuntimeEvents: RuntimeRecordingEvent[];
  newCursorEvents: CursorRecordingEvent[];
  newWhiteboardEvents: WhiteboardEvent[];
  newChatEvents: ChatRecordingEvent[];
}

const STREAMING_READER_INITIAL_CAPACITY = 64 * 1024;

export function createStreamingRecordingReader(): StreamingRecordingReader {
  let buffer = new Uint8Array(0);
  let retainedLength = 0;
  let totalLength = 0;

  let headerParsed = false;
  let meta: RecordingStreamMeta | null = null;
  let finalized = false;

  const frames: DeltaFrame[] = [];
  const slideEvents: SlideEvent[] = [];
  const previewEvents: PreviewEvent[] = [];
  const previewInitialDocuments: PreviewInitialDocument[] = [];
  const previewPatchBatches: PreviewDomPatchBatch[] = [];
  const workspaceEvents: WorkspaceRecordingEvent[] = [];
  const runtimeEvents: RuntimeRecordingEvent[] = [];
  const cursorEvents: CursorRecordingEvent[] = [];
  const whiteboardEvents: WhiteboardEvent[] = [];
  const chatEvents: ChatRecordingEvent[] = [];
  const clusterMap = new Map<number, RecordingClusterMeta>();
  // Segments arrive in stream (= encode) order, so one carry map per reader mirrors
  // the writer's stripper state (see workspaceEventDedup.ts).
  const hydrateWorkspaceEvents = createWorkspaceEventContentHydrator();
  // Same stream-order contract for repeated rrweb added-node payloads
  // (see previewPatchDedup.ts).
  const hydratePreviewPatchBatches = createPreviewAddNodeHydrator();

  let segmentCount = 0;
  let maxSegmentTimeMs = 0;

  let deltaCursor = 0;
  let deliveredSegmentCount = 0;
  let deliveredDuration = 0;
  let deliveredFinalized = false;
  const deliveredRecordCounts = {
    frames: 0,
    slideEvents: 0,
    previewEvents: 0,
    previewInitialDocuments: 0,
    previewPatchBatches: 0,
    workspaceEvents: 0,
    runtimeEvents: 0,
    cursorEvents: 0,
    whiteboardEvents: 0,
    chatEvents: 0,
  };

  const append = (incoming: Uint8Array): void => {
    if (totalLength + incoming.length > MAX_STREAM_BYTES) {
      throw new Error("Invalid SCR3 stream: recording exceeds the size limit");
    }
    if (retainedLength + incoming.length > buffer.length) {
      let capacity = buffer.length || STREAMING_READER_INITIAL_CAPACITY;
      while (capacity < retainedLength + incoming.length) {
        capacity *= 2;
      }
      const next = new Uint8Array(capacity);
      next.set(buffer.subarray(0, retainedLength), 0);
      buffer = next;
    }
    buffer.set(incoming, retainedLength);
    retainedLength += incoming.length;
    totalLength += incoming.length;
  };

  const discardPrefix = (byteLength: number): void => {
    if (byteLength <= 0) return;
    if (byteLength > retainedLength) {
      throw new Error("SCR3 streaming reader consumed past its retained input");
    }

    const remaining = retainedLength - byteLength;
    if (remaining > 0) {
      buffer.copyWithin(0, byteLength, retainedLength);
    }
    retainedLength = remaining;

    // Release a large segment allocation once only a small tail remains. Capacity
    // therefore follows the largest incomplete unit instead of the whole download.
    const minimumCapacity = Math.max(STREAMING_READER_INITIAL_CAPACITY, remaining * 2);
    if (buffer.byteLength > minimumCapacity * 2) {
      let capacity = STREAMING_READER_INITIAL_CAPACITY;
      while (capacity < remaining) capacity *= 2;
      const next = new Uint8Array(capacity);
      next.set(buffer.subarray(0, remaining));
      buffer = next;
    }
  };

  const tryParseHeader = (): void => {
    if (headerParsed || retainedLength < HEADER_PREFIX_SIZE) return;
    if (!hasMagicAt(buffer, 0)) {
      throw new Error("Invalid SCR3 stream: bad magic number");
    }
    const view = new DataView(buffer.buffer, buffer.byteOffset, retainedLength);
    const metaLength = view.getUint32(8, true);
    if (metaLength === 0 || metaLength > MAX_COMPRESSED_META_BYTES) {
      throw new Error("Invalid SCR3 stream: bad header length");
    }
    const metaEnd = HEADER_PREFIX_SIZE + metaLength;
    if (metaEnd > retainedLength) return; // header not fully downloaded yet

    const formatVersion = view.getUint16(4, true);
    if (formatVersion !== STREAM_FORMAT_VERSION) {
      throw new Error(`Unsupported SCR3 format version: ${formatVersion}`);
    }
    meta = parseHeader(buffer.subarray(0, metaEnd)).meta;
    headerParsed = true;
    deliveredDuration = meta.duration;
    discardPrefix(metaEnd);
  };

  // Decodes the payload *before* mutating any accumulator so that a throw (a partial
  // footer misparsed as a segment, or genuine corruption) leaves the reader's state and
  // cursor untouched and the parse can be safely retried or rolled back.
  const ingestSegment = (header: SegmentHeaderFields, payload: Uint8Array): void => {
    if (!meta) return;
    if (header.byteLength > MAX_COMPRESSED_SEGMENT_BYTES) {
      throw new Error("Invalid SCR3 stream: segment exceeds the compressed size limit");
    }

    let commit: () => void;
    let pendingRecordCount = 0;
    switch (header.kind) {
      case SEGMENT_KIND.frames: {
        // Resolve per-segment previewState-content markers first (self-contained,
        // no reader state — see framePreviewContentDedup.ts), then normalize each
        // frame once, as it arrives. `getRecording()` then skips the
        // whole-recording normalize pass (`prenormalized`), so progressive decoding
        // stays O(total bytes) instead of re-cloning every frame per interval.
        const records = hydrateFramePreviewContent(decodeRecords<DeltaFrame>(payload)).map(
          normalizeDeltaFrame,
        );
        pendingRecordCount = records.length;
        commit = () => frames.push(...records);
        break;
      }
      case SEGMENT_KIND.slide: {
        const records = decodeRecords<SlideEvent>(payload);
        pendingRecordCount = records.length;
        commit = () => slideEvents.push(...records);
        break;
      }
      case SEGMENT_KIND.preview: {
        const records = decodeRecords<PreviewEvent>(payload);
        pendingRecordCount = records.length;
        commit = () => previewEvents.push(...records);
        break;
      }
      case SEGMENT_KIND.previewDoc: {
        const records = decodeRecords<PreviewInitialDocument>(payload);
        pendingRecordCount = records.length;
        commit = () => previewInitialDocuments.push(...records);
        break;
      }
      case SEGMENT_KIND.previewPatch: {
        const records = decodeRecords<PreviewDomPatchBatch>(payload);
        pendingRecordCount = records.length;
        // Hydration advances the template list, so it runs inside `commit` — a
        // decode throw above must leave the dedup state untouched.
        commit = () => previewPatchBatches.push(...hydratePreviewPatchBatches(records));
        break;
      }
      case SEGMENT_KIND.workspace: {
        const records = decodeRecords<WorkspaceRecordingEvent>(payload);
        pendingRecordCount = records.length;
        // Hydration advances the carry map, so it runs inside `commit` — a decode
        // throw above must leave the dedup state untouched along with the arrays.
        commit = () => workspaceEvents.push(...hydrateWorkspaceEvents(records));
        break;
      }
      case SEGMENT_KIND.runtime: {
        const records = decodeRecords<RuntimeRecordingEvent>(payload);
        pendingRecordCount = records.length;
        commit = () => runtimeEvents.push(...records);
        break;
      }
      case SEGMENT_KIND.cursor: {
        const records = decodeRecords<CursorRecordingEvent>(payload);
        pendingRecordCount = records.length;
        commit = () => cursorEvents.push(...records);
        break;
      }
      case SEGMENT_KIND.whiteboard: {
        const records = decodeRecords<WhiteboardEvent>(payload);
        pendingRecordCount = records.length;
        commit = () => whiteboardEvents.push(...records);
        break;
      }
      case SEGMENT_KIND.chat: {
        const records = decodeRecords<ChatRecordingEvent>(payload);
        pendingRecordCount = records.length;
        commit = () => chatEvents.push(...records);
        break;
      }
      case SEGMENT_KIND.finalMeta: {
        const finalMeta = mergeFinalMetadata(meta, payload);
        commit = () => {
          meta = finalMeta;
        };
        break;
      }
      default:
        commit = () => {};
    }

    const decodedRecordCount =
      frames.length +
      slideEvents.length +
      previewEvents.length +
      previewInitialDocuments.length +
      previewPatchBatches.length +
      workspaceEvents.length +
      runtimeEvents.length +
      cursorEvents.length +
      whiteboardEvents.length +
      chatEvents.length;
    if (decodedRecordCount + pendingRecordCount > MAX_DECODED_RECORDS) {
      throw new Error("Invalid SCR3 stream: recording contains too many records");
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
    if (!headerParsed || finalized) return;

    const retained = buffer.subarray(0, retainedLength);
    const footerStart = findFooterStart(retained, 0);
    const segmentsEnd = footerStart ?? retainedLength;
    const view = new DataView(buffer.buffer, buffer.byteOffset, retainedLength);
    let cursor = 0;

    while (cursor + SEGMENT_HEADER_SIZE <= segmentsEnd) {
      const header = readSegmentHeader(view, cursor);
      const payloadStart = cursor + SEGMENT_HEADER_SIZE;
      const payloadEnd = payloadStart + header.byteLength;

      if (payloadEnd > segmentsEnd) {
        break; // segment not fully downloaded yet
      }
      if (!isKnownSegmentKind(header.kind)) {
        // Until the footer is confirmed these bytes might be a partial footer rather
        // than a real segment, so wait. Once the footer is visible, an unknown kind
        // inside its segment region is a genuine future segment that is safe to skip.
        if (footerStart === null) break;
        cursor = payloadEnd;
        segmentCount += 1;
        continue;
      }

      try {
        ingestSegment(header, buffer.subarray(payloadStart, payloadEnd));
      } catch (error) {
        // Inside the segment region (footer already seen) this is real corruption.
        // Otherwise these are most likely partial-footer bytes that happen to read as
        // a known kind — leave the cursor put and wait for the footer to complete.
        if (footerStart !== null) throw error;
        break;
      }
      cursor = payloadEnd;
    }

    if (footerStart !== null) {
      if (cursor !== footerStart) {
        throw new Error("Invalid SCR3 stream: malformed segment tail before footer");
      }
      const footerSegmentCount = view.getUint32(footerStart, true);
      if (footerSegmentCount !== segmentCount) {
        throw new Error("Invalid SCR3 stream: footer segment count does not match the stream");
      }
      finalized = true;
      discardPrefix(retainedLength);
      return;
    }

    discardPrefix(cursor);
  };

  return {
    push(bytes) {
      const endPushSpan = startPerformanceSpan("recording.reader_push");
      let outcome = "success";
      try {
        if (bytes.length > 0) {
          if (finalized) {
            throw new Error("Invalid SCR3 stream: bytes found after the footer");
          }
          append(bytes);
        }
        tryParseHeader();
        parseSegments();
      } catch (error) {
        outcome = "failure";
        throw error;
      } finally {
        endPushSpan({ outcome });
        recordPerformanceMetric("recording.reader_retained", retainedLength, "bytes");
        recordPerformanceMetric("recording.reader_capacity", buffer.byteLength, "bytes");
      }
    },
    readDelta() {
      if (!headerParsed || !meta) return null;
      const duration = Math.max(meta.duration, maxSegmentTimeMs);
      const hasChanges =
        deliveredSegmentCount !== segmentCount ||
        deliveredDuration !== duration ||
        deliveredFinalized !== finalized;
      if (!hasChanges) return null;

      const delta: StreamingRecordingDelta = {
        cursor: ++deltaCursor,
        recordingId: meta.id,
        duration,
        streamFinalized: finalized,
        newFrames: frames.slice(deliveredRecordCounts.frames),
        newSlideEvents: slideEvents.slice(deliveredRecordCounts.slideEvents),
        newPreviewEvents: previewEvents.slice(deliveredRecordCounts.previewEvents),
        newPreviewInitialDocuments: previewInitialDocuments.slice(
          deliveredRecordCounts.previewInitialDocuments,
        ),
        newPreviewPatchBatches: previewPatchBatches.slice(
          deliveredRecordCounts.previewPatchBatches,
        ),
        newWorkspaceEvents: workspaceEvents.slice(deliveredRecordCounts.workspaceEvents),
        newRuntimeEvents: runtimeEvents.slice(deliveredRecordCounts.runtimeEvents),
        newCursorEvents: cursorEvents.slice(deliveredRecordCounts.cursorEvents),
        newWhiteboardEvents: whiteboardEvents.slice(deliveredRecordCounts.whiteboardEvents),
        newChatEvents: chatEvents.slice(deliveredRecordCounts.chatEvents),
      };

      deliveredSegmentCount = segmentCount;
      deliveredDuration = duration;
      deliveredFinalized = finalized;
      deliveredRecordCounts.frames = frames.length;
      deliveredRecordCounts.slideEvents = slideEvents.length;
      deliveredRecordCounts.previewEvents = previewEvents.length;
      deliveredRecordCounts.previewInitialDocuments = previewInitialDocuments.length;
      deliveredRecordCounts.previewPatchBatches = previewPatchBatches.length;
      deliveredRecordCounts.workspaceEvents = workspaceEvents.length;
      deliveredRecordCounts.runtimeEvents = runtimeEvents.length;
      deliveredRecordCounts.cursorEvents = cursorEvents.length;
      deliveredRecordCounts.whiteboardEvents = whiteboardEvents.length;
      deliveredRecordCounts.chatEvents = chatEvents.length;
      return delta;
    },
    getRecording() {
      if (!headerParsed || !meta) return null;
      const endSnapshotSpan = startPerformanceSpan("recording.reader_snapshot");
      try {
        return assembleRecording({
          meta,
          streamFinalized: finalized,
          // Frames were normalized at ingest; skip the whole-recording normalize pass.
          prenormalized: true,
          hasSegments: segmentCount > 0,
          maxSegmentTimeMs: Math.max(meta.duration, maxSegmentTimeMs),
          // Fresh arrays per snapshot so consumers keyed on reference see the growth;
          // copying pointers is cheap, unlike the per-frame deep clone this replaces.
          frames: frames.slice(),
          slideEvents: slideEvents.slice(),
          previewEvents: previewEvents.slice(),
          previewInitialDocuments: previewInitialDocuments.slice(),
          previewPatchBatches: previewPatchBatches.slice(),
          workspaceEvents: workspaceEvents.slice(),
          runtimeEvents: runtimeEvents.slice(),
          cursorEvents: cursorEvents.slice(),
          whiteboardEvents: whiteboardEvents.slice(),
          chatEvents: chatEvents.slice(),
          clusterSummaries: Array.from(clusterMap.values()),
        });
      } finally {
        endSnapshotSpan();
      }
    },
    isFinalized() {
      return finalized;
    },
    byteLength() {
      return totalLength;
    },
    retainedByteLength() {
      return retainedLength;
    },
    retainedCapacity() {
      return buffer.byteLength;
    },
  };
}
