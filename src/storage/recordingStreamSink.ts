import type { RecordingStreamSink } from "../core/src/types";
import type { RecordingSession } from "../core/src/machine/types";
import { DELTA_CONFIG } from "../core/src/utils/deltaTypes";
import { isKeyframe } from "../core/src/utils/deltaTypes";
import {
  SEGMENT_KIND,
  createStreamingRecordingWriter,
  type RecordingStreamMeta,
  type StreamingRecordingWriter,
} from "./streamingRecordingCodec";

/**
 * Flush event segments once this many new records have accumulated (or on finish), so
 * high-cadence streams like cursor samples don't produce a deflate segment per record.
 */
const EVENT_FLUSH_THRESHOLD = 32;

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read audio blob"));
    reader.readAsArrayBuffer(blob);
  });
}

function readRecordTimestamp(record: unknown): number {
  if (record && typeof record === "object") {
    const value = record as { timestamp?: unknown; time?: unknown };
    if (typeof value.timestamp === "number") return value.timestamp;
    if (typeof value.time === "number") return value.time;
  }
  return 0;
}

interface StreamedCounts {
  frames: number;
  slide: number;
  preview: number;
  previewDoc: number;
  previewPatch: number;
  workspace: number;
  runtime: number;
  cursor: number;
}

interface RecordingStreamBridgeStartOptions {
  audioType?: string;
  audioSource?: RecordingStreamMeta["audioSource"];
  audioStartOffsetMs?: number;
  cameraType?: string;
  cameraSource?: RecordingStreamMeta["cameraSource"];
  cameraStartOffsetMs?: number;
}

interface PendingStreamSegment {
  clusterIndex: number;
  startTimeMs: number;
  priority: number;
  write: () => void | Promise<void>;
}

/**
 * Bridges an in-progress `RecordingSession` to a {@link RecordingStreamSink} by appending
 * newly-captured records to a live SCR3 writer and forwarding the drained bytes.
 *
 * Frame segments are flushed at keyframe boundaries (range-loadable) and event segments on a
 * small threshold, matching the SCR3 batching policy. Audio and camera fragments are read
 * asynchronously and appended in capture order. The emitted bytes are the same SCR3 stream the
 * exporter produces, so a remote consumer can replay them with `decodeRecordingPrefix`.
 */
export class RecordingStreamBridge {
  private readonly writer: StreamingRecordingWriter = createStreamingRecordingWriter();
  private readonly counts: StreamedCounts = {
    frames: 0,
    slide: 0,
    preview: 0,
    previewDoc: 0,
    previewPatch: 0,
    workspace: 0,
    runtime: 0,
    cursor: 0,
  };
  /** Number of audio fragments already scheduled for streaming. */
  private audioCount = 0;
  /** Number of camera fragments already scheduled for streaming. */
  private cameraCount = 0;
  /** Timeline starts for SCR3 cluster indices known to the live bridge. */
  private readonly clusterStarts: number[] = [];
  /** Serializes segment appends so async media reads cannot reorder the SCR3 stream. */
  private appendQueue: Promise<void> = Promise.resolve();
  /** Serializes sink writes so the consumer receives bytes in stream order. */
  private writeChain: Promise<void> = Promise.resolve();
  private started = false;
  private lastSession: RecordingSession | null = null;
  private readonly sink: RecordingStreamSink;

  constructor(sink: RecordingStreamSink) {
    this.sink = sink;
  }

  /**
   * Writes the stream header and forwards it to the sink. Media types are the MIME types the
   * decoder should wrap reassembled blobs in (omit when the recording has no media).
   */
  start(session: RecordingSession, options: RecordingStreamBridgeStartOptions = {}): void {
    if (this.started) return;
    const meta: RecordingStreamMeta = {
      version: 3,
      id: String(session.startedAt),
      name: `Recording ${session.startedAt}`,
      keyframeInterval: DELTA_CONFIG.KEYFRAME_INTERVAL,
      createdAt: session.startedAt,
      duration: 0,
      audioType: options.audioType,
      audioSource: options.audioSource,
      audioStartOffsetMs: options.audioStartOffsetMs,
      cameraType: options.cameraType,
      cameraSource: options.cameraSource,
      cameraStartOffsetMs: options.cameraStartOffsetMs,
    };
    this.writer.writeHeader(meta);
    this.started = true;
    this.flush();
  }

  /** Appends records captured since the previous sync and forwards the new bytes. */
  sync(session: RecordingSession): void {
    if (!this.started) return;
    this.lastSession = session;
    this.enqueueSegments(this.collectSessionSegments(session, false));
  }

  /** Flushes any buffered tail, finalizes the stream (footer), and closes the sink. */
  async finish(): Promise<void> {
    if (!this.started) {
      await this.closeSink();
      return;
    }
    if (this.lastSession) {
      this.enqueueSegments(this.collectSessionSegments(this.lastSession, true));
    }
    // All media must be appended before the footer so the finalized stream is complete.
    await this.appendQueue;
    this.writer.finalize();
    this.flush();
    await this.closeSink();
  }

  /** Closes the sink without finalizing (e.g. on unmount mid-recording). */
  abort(): void {
    void this.closeSink();
  }

  private collectSessionSegments(
    session: RecordingSession,
    final: boolean,
  ): PendingStreamSegment[] {
    return [
      ...this.collectFrameSegments(session.frames, final),
      ...this.collectEventSegments(SEGMENT_KIND.slide, session.slideEvents, "slide", final),
      ...this.collectEventSegments(SEGMENT_KIND.preview, session.previewEvents, "preview", final),
      ...this.collectEventSegments(
        SEGMENT_KIND.previewDoc,
        session.previewInitialDocuments,
        "previewDoc",
        final,
      ),
      ...this.collectEventSegments(
        SEGMENT_KIND.previewPatch,
        session.previewPatchBatches,
        "previewPatch",
        final,
      ),
      ...this.collectEventSegments(
        SEGMENT_KIND.workspace,
        session.workspaceEvents,
        "workspace",
        final,
      ),
      ...this.collectEventSegments(SEGMENT_KIND.runtime, session.runtimeEvents, "runtime", final),
      ...this.collectEventSegments(SEGMENT_KIND.cursor, session.cursorEvents, "cursor", final),
      ...this.collectAudioSegments(session.audioFragments),
      ...this.collectCameraSegments(session.cameraFragments),
    ];
  }

  private enqueueSegments(segments: PendingStreamSegment[]): void {
    if (segments.length === 0) return;
    const orderedSegments = [...segments].sort(
      (left, right) =>
        left.clusterIndex - right.clusterIndex ||
        left.startTimeMs - right.startTimeMs ||
        left.priority - right.priority,
    );

    this.appendQueue = this.appendQueue.then(async () => {
      for (const segment of orderedSegments) {
        await segment.write();
        this.flush();
      }
    });
  }

  private collectFrameSegments(
    frames: RecordingSession["frames"],
    final: boolean,
  ): PendingStreamSegment[] {
    const segments: PendingStreamSegment[] = [];
    // Emit a segment for each completed keyframe-bounded run; keep the trailing run
    // buffered until its next keyframe arrives (or until finish).
    for (let index = this.counts.frames + 1; index < frames.length; index++) {
      if (isKeyframe(frames[index])) {
        const batch = frames.slice(this.counts.frames, index);
        const segment = this.createFrameSegment(batch, frames[index].timestamp);
        segments.push(segment);
        const clusterIndex = segment.clusterIndex;
        this.ensureClusterStart(clusterIndex + 1, frames[index].timestamp);
        this.counts.frames = index;
      }
    }
    if (final && this.counts.frames < frames.length) {
      const batch = frames.slice(this.counts.frames);
      segments.push(this.createFrameSegment(batch, batch[batch.length - 1]?.timestamp ?? 0));
      this.counts.frames = frames.length;
    }
    return segments;
  }

  private createFrameSegment(
    frames: RecordingSession["frames"],
    endTimeMs: number,
  ): PendingStreamSegment {
    const startTimeMs = frames[0]?.timestamp ?? 0;
    const clusterIndex = this.resolveClusterIndex(startTimeMs);
    this.ensureClusterStart(clusterIndex, startTimeMs);
    return {
      clusterIndex,
      startTimeMs,
      priority: 0,
      write: () =>
        this.writer.appendFrameSegment(frames, {
          startTimeMs,
          endTimeMs: Math.max(startTimeMs, endTimeMs),
          clusterIndex,
          containsKeyframe: frames.some(isKeyframe),
        }),
    };
  }

  private ensureClusterStart(clusterIndex: number, startTimeMs: number): void {
    if (clusterIndex < 0) return;
    const current = this.clusterStarts[clusterIndex];
    if (typeof current === "number") {
      this.clusterStarts[clusterIndex] = Math.min(current, startTimeMs);
      return;
    }
    this.clusterStarts[clusterIndex] = startTimeMs;
  }

  private resolveClusterIndex(timeMs: number): number {
    for (let index = this.clusterStarts.length - 1; index >= 0; index -= 1) {
      const startTimeMs = this.clusterStarts[index];
      if (typeof startTimeMs === "number" && timeMs >= startTimeMs) {
        return index;
      }
    }
    return 0;
  }

  private collectEventSegments(
    kind: (typeof SEGMENT_KIND)[keyof typeof SEGMENT_KIND],
    records: ReadonlyArray<unknown>,
    key: keyof StreamedCounts,
    final: boolean,
  ): PendingStreamSegment[] {
    const pending = records.length - this.counts[key];
    if (pending <= 0) return [];
    if (!final && pending < EVENT_FLUSH_THRESHOLD) return [];
    const pendingRecords = records.slice(this.counts[key]);
    const segments: PendingStreamSegment[] = [];
    let groupStart = 0;
    while (groupStart < pendingRecords.length) {
      const firstTimestamp = readRecordTimestamp(pendingRecords[groupStart]);
      const clusterIndex = this.resolveClusterIndex(firstTimestamp);
      let groupEnd = groupStart + 1;
      while (
        groupEnd < pendingRecords.length &&
        this.resolveClusterIndex(readRecordTimestamp(pendingRecords[groupEnd])) === clusterIndex
      ) {
        groupEnd += 1;
      }

      const group = pendingRecords.slice(groupStart, groupEnd);
      segments.push({
        clusterIndex,
        startTimeMs: firstTimestamp,
        priority: 1,
        write: () =>
          this.writer.appendEventSegment(kind, group, {
            startTimeMs: firstTimestamp,
            endTimeMs: readRecordTimestamp(group[group.length - 1]),
            clusterIndex,
          }),
      });
      groupStart = groupEnd;
    }
    this.counts[key] = records.length;
    return segments;
  }

  private collectAudioSegments(
    fragments: RecordingSession["audioFragments"],
  ): PendingStreamSegment[] {
    const segments: PendingStreamSegment[] = [];
    while (this.audioCount < fragments.length) {
      const fragment = fragments[this.audioCount];
      const fragmentIndex = this.audioCount;
      this.audioCount += 1;
      const clusterIndex = this.resolveClusterIndex(fragment.startTimeMs);
      segments.push({
        clusterIndex,
        startTimeMs: fragment.startTimeMs,
        priority: 2,
        write: async () => {
          const bytes = await blobToBytes(fragment.blob);
          this.writer.appendAudioChunk(bytes, {
            startTimeMs: fragment.startTimeMs,
            endTimeMs: fragment.endTimeMs,
            clusterIndex,
            isInit: fragmentIndex === 0,
          });
        },
      });
    }
    return segments;
  }

  private collectCameraSegments(
    fragments: RecordingSession["cameraFragments"],
  ): PendingStreamSegment[] {
    const segments: PendingStreamSegment[] = [];
    while (this.cameraCount < fragments.length) {
      const fragment = fragments[this.cameraCount];
      const fragmentIndex = this.cameraCount;
      this.cameraCount += 1;
      const clusterIndex = this.resolveClusterIndex(fragment.startTimeMs);
      segments.push({
        clusterIndex,
        startTimeMs: fragment.startTimeMs,
        priority: 3,
        write: async () => {
          const bytes = await blobToBytes(fragment.blob);
          this.writer.appendCameraChunk(bytes, {
            startTimeMs: fragment.startTimeMs,
            endTimeMs: fragment.endTimeMs,
            clusterIndex,
            isInit: fragmentIndex === 0,
          });
        },
      });
    }
    return segments;
  }

  private flush(): void {
    const bytes = this.writer.drainPending();
    if (bytes.length === 0) return;
    this.writeChain = this.writeChain.then(() => this.sink.write(bytes));
  }

  private async closeSink(): Promise<void> {
    await this.writeChain;
    await this.sink.close();
  }
}
