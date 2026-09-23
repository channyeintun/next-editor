import type { Recording, RecordingStreamDelta } from "../../core/src";
import type { CursorRecordingEvent, RecordingClusterMeta } from "../../core/src/types";
import type {
  PreviewDomPatchBatch,
  PreviewEvent,
  PreviewInitialDocument,
  SlideEvent,
} from "../../core/src/slides";
import type { DeltaFrame } from "../../core/src/utils/deltaTypes";
import { normalizeDeltaFrame } from "../../core/src/utils/editorState";
import type { RuntimeRecordingEvent } from "../../types/runtime";
import type { WorkspaceRecordingAsset, WorkspaceRecordingEvent } from "../../types/workspace";
import type { WhiteboardEvent } from "../../core/src/whiteboard";
import type { ChatRecordingEvent } from "../../types/chat";
import {
  decodeRecords,
  createInflationBudget,
  type InflationBudget,
  decodeWorkspaceAssetPayload,
  findFooterStart,
  hasMagicAt,
  HEADER_PREFIX_SIZE,
  isKnownSegmentKind,
  parseHeader,
  readSegmentHeader,
  SEGMENT_HEADER_SIZE,
  SEGMENT_KIND,
  MAX_COMPRESSED_META_BYTES,
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
// only newly-completed segments per push. Both decode every segment through
// `ingestSegment` and build the result with `assembleRecording`, so a
// progressively-decoded prefix and a one-shot decode of the same bytes match.
// ============================================================================

/** One complete segment inside a byte range: its header fields plus a view of its payload. */
interface WalkedSegment {
  header: SegmentHeaderFields;
  payload: Uint8Array;
}

function assertFrameFormatCompatibility(
  frames: ReadonlyArray<DeltaFrame>,
  formatVersion: number,
): void {
  if (formatVersion >= 3) return;
  if (frames.some((frame) => !frame.isKeyframe && frame.contentEditDelta !== undefined)) {
    throw new Error("Invalid SCR3 v2 stream: content edit deltas require format version 3");
  }
}

function assertWorkspaceAssetFormatCompatibility(formatVersion: number): void {
  if (formatVersion >= 4) return;
  throw new Error("Invalid SCR3 stream: workspace assets require format version 4");
}

/**
 * Yields every complete segment of a known kind in `[start, end)`. Unknown (future)
 * kinds are self-delimiting, so they are skipped rather than aborting the walk and
 * silently dropping every later segment plus the footer. A segment that runs past
 * `end` is a truncated tail, and the walk stops there.
 */
function* walkSegments(bytes: Uint8Array, start: number, end: number): Generator<WalkedSegment> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = start;

  while (offset + SEGMENT_HEADER_SIZE <= end) {
    const header = readSegmentHeader(view, offset);
    const payloadStart = offset + SEGMENT_HEADER_SIZE;
    const payloadEnd = payloadStart + header.byteLength;
    if (payloadEnd > end) return;

    if (isKnownSegmentKind(header.kind)) {
      yield { header, payload: bytes.subarray(payloadStart, payloadEnd) };
    }
    offset = payloadEnd;
  }
}

/** Decoded records per track, each in stream (timeline) order. */
interface DecodedRecords {
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
}

/** Fresh arrays holding the same record objects, so consumers keyed on reference see growth. */
function copyDecodedRecords(records: DecodedRecords): DecodedRecords {
  return {
    frames: records.frames.slice(),
    slideEvents: records.slideEvents.slice(),
    previewEvents: records.previewEvents.slice(),
    previewInitialDocuments: records.previewInitialDocuments.slice(),
    previewPatchBatches: records.previewPatchBatches.slice(),
    workspaceEvents: records.workspaceEvents.slice(),
    runtimeEvents: records.runtimeEvents.slice(),
    cursorEvents: records.cursorEvents.slice(),
    whiteboardEvents: records.whiteboardEvents.slice(),
    chatEvents: records.chatEvents.slice(),
  };
}

/**
 * Everything decoded from one SCR3 stream so far. The one-shot decoder and the
 * streaming reader both advance it through {@link ingestSegment}, so a progressively
 * decoded prefix and a one-shot decode of the same bytes cannot drift apart.
 */
interface DecodedStream {
  /** The header's metadata until a final-metadata segment replaces it. */
  meta: RecordingStreamMeta;
  readonly formatVersion: number;
  /** MAX_INFLATED_SEGMENT_BYTES bounds each segment; this bounds their sum. */
  readonly budget: InflationBudget;
  readonly records: DecodedRecords;
  /**
   * Raw assets not yet handed off. Their bytes are not part of the long-lived decoded
   * recording, so the streaming reader drains this queue on every `readDelta`.
   */
  readonly workspaceAssets: WorkspaceRecordingAsset[];
  /** Every asset id ever decoded, drained or not, so a repeated asset segment is caught. */
  readonly workspaceAssetIds: Set<string>;
  readonly clusterSummaries: Map<number, RecordingClusterMeta>;
  /**
   * Stream-order carries that mirror the writer's strippers: segments arrive in encode
   * order, so one carry per stream resolves every dedup marker (see
   * workspaceEventDedup.ts and previewPatchDedup.ts).
   */
  readonly hydrateWorkspaceEvents: (events: WorkspaceRecordingEvent[]) => WorkspaceRecordingEvent[];
  readonly hydratePreviewPatchBatches: (batches: PreviewDomPatchBatch[]) => PreviewDomPatchBatch[];
  /** Segments accepted so far, including skipped unknown kinds; the footer must agree. */
  segmentCount: number;
  recordCount: number;
  maxSegmentTimeMs: number;
}

function createDecodedStream(meta: RecordingStreamMeta, formatVersion: number): DecodedStream {
  return {
    meta,
    formatVersion,
    budget: createInflationBudget(),
    records: {
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
    },
    workspaceAssets: [],
    workspaceAssetIds: new Set(),
    clusterSummaries: new Map(),
    hydrateWorkspaceEvents: createWorkspaceEventContentHydrator(),
    hydratePreviewPatchBatches: createPreviewAddNodeHydrator(),
    segmentCount: 0,
    recordCount: 0,
    maxSegmentTimeMs: 0,
  };
}

function mergeFinalMetadata(
  current: RecordingStreamMeta,
  payload: Uint8Array,
  budget: InflationBudget,
): RecordingStreamMeta {
  const records = decodeRecords<RecordingStreamMeta>(payload, budget);
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

/** A decoded segment waiting to be applied: `commit` only appends, so it cannot throw. */
interface PendingSegment {
  recordCount: number;
  commit(): void;
}

/**
 * Decodes one segment's payload without touching the stream. Every step that can
 * throw runs here, so a throw (a partial footer misread as a segment, or genuine
 * corruption) leaves the records, the dedup carries and the counters as they were,
 * and the streaming reader can retry the same bytes once more have arrived.
 */
function decodeSegment(stream: DecodedStream, kind: number, payload: Uint8Array): PendingSegment {
  const { records, budget } = stream;
  switch (kind) {
    case SEGMENT_KIND.frames: {
      // Resolve the segment's previewState-content markers (self-contained, no carry —
      // see framePreviewContentDedup.ts), then normalize each frame once, as it arrives,
      // so a growing stream never re-normalizes the frames it already holds.
      const frames = hydrateFramePreviewContent(decodeRecords<DeltaFrame>(payload, budget)).map(
        normalizeDeltaFrame,
      );
      assertFrameFormatCompatibility(frames, stream.formatVersion);
      return { recordCount: frames.length, commit: () => records.frames.push(...frames) };
    }
    case SEGMENT_KIND.slide:
      return appendTo(records.slideEvents, decodeRecords<SlideEvent>(payload, budget));
    case SEGMENT_KIND.preview:
      return appendTo(records.previewEvents, decodeRecords<PreviewEvent>(payload, budget));
    case SEGMENT_KIND.previewDoc:
      return appendTo(
        records.previewInitialDocuments,
        decodeRecords<PreviewInitialDocument>(payload, budget),
      );
    case SEGMENT_KIND.previewPatch: {
      const batches = decodeRecords<PreviewDomPatchBatch>(payload, budget);
      // Hydration advances the template list, so it runs at commit.
      return {
        recordCount: batches.length,
        commit: () =>
          records.previewPatchBatches.push(...stream.hydratePreviewPatchBatches(batches)),
      };
    }
    case SEGMENT_KIND.workspace: {
      const events = decodeRecords<WorkspaceRecordingEvent>(payload, budget);
      // Hydration advances the carried file contents, so it runs at commit.
      return {
        recordCount: events.length,
        commit: () => records.workspaceEvents.push(...stream.hydrateWorkspaceEvents(events)),
      };
    }
    case SEGMENT_KIND.workspaceAsset: {
      assertWorkspaceAssetFormatCompatibility(stream.formatVersion);
      const asset = decodeWorkspaceAssetPayload(payload);
      if (stream.workspaceAssetIds.has(asset.descriptor.assetId)) {
        throw new Error("Invalid SCR3 stream: duplicate workspace asset segment");
      }
      return {
        recordCount: 1,
        commit: () => {
          stream.workspaceAssetIds.add(asset.descriptor.assetId);
          stream.workspaceAssets.push(asset);
        },
      };
    }
    case SEGMENT_KIND.runtime:
      return appendTo(records.runtimeEvents, decodeRecords<RuntimeRecordingEvent>(payload, budget));
    case SEGMENT_KIND.cursor:
      return appendTo(records.cursorEvents, decodeRecords<CursorRecordingEvent>(payload, budget));
    case SEGMENT_KIND.whiteboard:
      return appendTo(records.whiteboardEvents, decodeRecords<WhiteboardEvent>(payload, budget));
    case SEGMENT_KIND.chat:
      return appendTo(records.chatEvents, decodeRecords<ChatRecordingEvent>(payload, budget));
    case SEGMENT_KIND.finalMeta: {
      const meta = mergeFinalMetadata(stream.meta, payload, budget);
      return {
        recordCount: 0,
        commit: () => {
          stream.meta = meta;
        },
      };
    }
    default:
      return { recordCount: 0, commit: () => {} };
  }
}

function appendTo<T>(target: T[], decoded: T[]): PendingSegment {
  return { recordCount: decoded.length, commit: () => target.push(...decoded) };
}

/** Decodes one segment and, only if that succeeds, folds it into the stream. */
function ingestSegment(stream: DecodedStream, { header, payload }: WalkedSegment): void {
  const segment = decodeSegment(stream, header.kind, payload);
  if (stream.recordCount + segment.recordCount > MAX_DECODED_RECORDS) {
    throw new Error("Invalid SCR3 stream: recording contains too many records");
  }
  stream.segmentCount += 1;
  stream.recordCount += segment.recordCount;
  stream.maxSegmentTimeMs = Math.max(stream.maxSegmentTimeMs, header.startTimeMs, header.endTimeMs);
  mergeClusterSummary(
    stream.clusterSummaries,
    header.clusterIndex,
    header.startTimeMs,
    header.endTimeMs,
    header.containsKeyframe,
  );
  segment.commit();
}

/**
 * Builds a {@link Recording} from a decoded stream. `records` are passed separately
 * so the streaming reader can hand in a copy and keep its own arrays private.
 */
function assembleRecording(
  stream: DecodedStream,
  records: DecodedRecords,
  streamFinalized: boolean,
): Recording {
  const { meta } = stream;

  const provisionalRecording: Recording = {
    version: meta.version,
    id: meta.id,
    name: meta.name,
    keyframeInterval: meta.keyframeInterval,
    createdAt: meta.createdAt,
    duration: Math.max(meta.duration, stream.maxSegmentTimeMs),
    frames: records.frames,
    slideEvents: nonEmpty(records.slideEvents),
    previewEvents: nonEmpty(records.previewEvents),
    previewInitialDocuments: nonEmpty(records.previewInitialDocuments),
    previewPatchBatches: nonEmpty(records.previewPatchBatches),
    workspaceEvents: nonEmpty(records.workspaceEvents),
    workspaceAssets: nonEmpty(stream.workspaceAssets.slice()),
    runtimeEvents: nonEmpty(records.runtimeEvents),
    cursorEvents: nonEmpty(records.cursorEvents),
    whiteboardEvents: nonEmpty(records.whiteboardEvents),
    chatEvents: nonEmpty(records.chatEvents),
    captions: meta.captions,
    captionFiles: meta.captionFiles,
    slides: meta.slides,
    // Media bytes never live in the stream: audio and camera are sibling files, so the
    // header carries only their references and timeline offsets.
    audioSource: meta.audioSource,
    audioStartOffsetMs: meta.audioStartOffsetMs,
    audioFile: meta.audioFile,
    audioUrl: meta.audioUrl,
    cameraSource: meta.cameraSource,
    cameraStartOffsetMs: meta.cameraStartOffsetMs,
    cameraFile: meta.cameraFile,
    cameraUrl: meta.cameraUrl,
    streamFinalized,
    workspaceSnapshot: meta.workspaceSnapshot,
    runtimeSnapshot: meta.runtimeSnapshot,
  };

  // Copies, never the summaries themselves: later segments keep widening those in
  // place, and a recording already handed out must not change underneath its owner.
  const clusters =
    meta.clusters && meta.clusters.length > 0
      ? sortClusters(meta.clusters.map((cluster) => ({ ...cluster })))
      : stream.segmentCount > 0
        ? sortClusters(Array.from(stream.clusterSummaries.values(), (cluster) => ({ ...cluster })))
        : deriveRecordingClusters(provisionalRecording);

  const tracks =
    meta.tracks && meta.tracks.length > 0
      ? meta.tracks.map((track) => ({ ...track }))
      : deriveRecordingTracks(provisionalRecording);

  const mediaFragments = deriveRecordingMediaFragments(provisionalRecording, tracks, clusters);

  return {
    ...provisionalRecording,
    tracks: nonEmpty(tracks),
    clusters: nonEmpty(clusters),
    mediaFragments: nonEmpty(mediaFragments),
  };
}

function nonEmpty<T>(items: T[]): T[] | undefined {
  return items.length > 0 ? items : undefined;
}

function sortClusters(clusters: RecordingClusterMeta[]): RecordingClusterMeta[] {
  return clusters.sort((left, right) => left.index - right.index);
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
  const { meta, headerEnd, formatVersion } = parseHeader(bytes);
  const stream = createDecodedStream(meta, formatVersion);
  const footerStart = findFooterStart(bytes, headerEnd);

  for (const segment of walkSegments(bytes, headerEnd, footerStart ?? bytes.length)) {
    ingestSegment(stream, segment);
  }

  // A whole buffer may come from any writer, so order each track by time here. Array
  // sort is stable, so records already in timeline order keep their stream order.
  const { records } = stream;
  const byTimestamp = (left: { timestamp: number }, right: { timestamp: number }) =>
    left.timestamp - right.timestamp;
  const byTime = (left: { time: number }, right: { time: number }) => left.time - right.time;
  records.frames.sort(byTimestamp);
  records.slideEvents.sort(byTimestamp);
  records.previewEvents.sort(byTimestamp);
  records.previewInitialDocuments.sort(byTime);
  records.previewPatchBatches.sort(byTime);
  records.workspaceEvents.sort(byTimestamp);
  records.runtimeEvents.sort(byTimestamp);
  records.cursorEvents.sort(byTimestamp);
  records.whiteboardEvents.sort(byTimestamp);
  records.chatEvents.sort(byTimestamp);

  return assembleRecording(stream, records, footerStart !== null);
}

// ============================================================================
// Incremental streaming reader
//
// Feed network chunks with `push()`, append newly decoded records from `readDelta()`,
// and construct a complete `Recording` with `getRecording()` only when explicitly
// needed. Completed compressed input is discarded after each push, the header is
// parsed once, and segment payloads are inflated once. Frames are normalized once at
// ingest. Audio/camera remain external; workspace asset payloads are delivered once
// and released after `readDelta()` hands them to durable asset storage.
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

export type StreamingRecordingDelta = RecordingStreamDelta;

const STREAMING_READER_INITIAL_CAPACITY = 64 * 1024;

export function createStreamingRecordingReader(): StreamingRecordingReader {
  let buffer = new Uint8Array(0);
  let retainedLength = 0;
  let totalLength = 0;

  // Null until the header has fully arrived.
  let stream: DecodedStream | null = null;
  let finalized = false;

  let deltaCursor = 0;
  let deliveredSegmentCount = 0;
  let deliveredDuration = 0;
  let deliveredFinalized = false;
  const deliveredRecordCounts: Record<keyof DecodedRecords, number> = {
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
    if (stream || retainedLength < HEADER_PREFIX_SIZE) return;
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

    const { meta, formatVersion } = parseHeader(buffer.subarray(0, metaEnd));
    stream = createDecodedStream(meta, formatVersion);
    deliveredDuration = meta.duration;
    discardPrefix(metaEnd);
  };

  const parseSegments = (): void => {
    if (!stream || finalized) return;

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
        stream.segmentCount += 1;
        continue;
      }

      try {
        ingestSegment(stream, { header, payload: buffer.subarray(payloadStart, payloadEnd) });
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
      if (footerSegmentCount !== stream.segmentCount) {
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
      if (!stream) return null;
      const { meta, records } = stream;
      const duration = Math.max(meta.duration, stream.maxSegmentTimeMs);
      const hasChanges =
        deliveredSegmentCount !== stream.segmentCount ||
        deliveredDuration !== duration ||
        deliveredFinalized !== finalized;
      if (!hasChanges) return null;

      const undelivered = <K extends keyof DecodedRecords>(key: K): DecodedRecords[K] =>
        records[key].slice(deliveredRecordCounts[key]) as DecodedRecords[K];
      const delta: StreamingRecordingDelta = {
        cursor: ++deltaCursor,
        recordingId: meta.id,
        duration,
        streamFinalized: finalized,
        newFrames: undelivered("frames"),
        newSlideEvents: undelivered("slideEvents"),
        newPreviewEvents: undelivered("previewEvents"),
        newPreviewInitialDocuments: undelivered("previewInitialDocuments"),
        newPreviewPatchBatches: undelivered("previewPatchBatches"),
        newWorkspaceEvents: undelivered("workspaceEvents"),
        // Asset bytes are a handoff queue, not part of the long-lived decoded
        // recording. Consumers persist them before applying the returned delta.
        newWorkspaceAssets: stream.workspaceAssets.splice(0),
        newRuntimeEvents: undelivered("runtimeEvents"),
        newCursorEvents: undelivered("cursorEvents"),
        newWhiteboardEvents: undelivered("whiteboardEvents"),
        newChatEvents: undelivered("chatEvents"),
      };

      deliveredSegmentCount = stream.segmentCount;
      deliveredDuration = duration;
      deliveredFinalized = finalized;
      for (const key of Object.keys(deliveredRecordCounts) as Array<keyof DecodedRecords>) {
        deliveredRecordCounts[key] = records[key].length;
      }
      return delta;
    },
    getRecording() {
      if (!stream) return null;
      const endSnapshotSpan = startPerformanceSpan("recording.reader_snapshot");
      try {
        return assembleRecording(stream, copyDecodedRecords(stream.records), finalized);
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
