import type { Recording, RecordingStreamSink } from "../core/src/types";
import type { RecordingSession } from "../core/src/machine/types";
import { DELTA_CONFIG } from "../core/src/utils/deltaTypes";
import { isKeyframe } from "../core/src/utils/deltaTypes";
import {
  SEGMENT_KIND,
  createRecordingStreamMeta,
  createStreamingRecordingWriter,
  readRecordTimestamp,
  type RecordingStreamMeta,
  type StreamingRecordingWriter,
} from "./streamingRecordingCodec";

/**
 * Flush event segments once this many new records have accumulated (or on finish), so
 * high-cadence streams like cursor samples don't produce a deflate segment per record.
 */
const EVENT_FLUSH_THRESHOLD = 32;

interface StreamedCounts {
  frames: number;
  slide: number;
  preview: number;
  previewDoc: number;
  previewPatch: number;
  workspace: number;
  runtime: number;
  cursor: number;
  whiteboard: number;
  chat: number;
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
 * small threshold, matching the SCR3 batching policy. Media bytes are never part of the stream —
 * audio and camera live in their own files/blobs, delivered outside this sink. The emitted bytes
 * are the same SCR3 stream the exporter produces, so a remote consumer can replay them with
 * `decodeRecordingStream`.
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
    whiteboard: 0,
    chat: 0,
  };
  /** Timeline starts for SCR3 cluster indices known to the live bridge. */
  private readonly clusterStarts: number[] = [];
  /** Serializes encoding and sink writes, providing one-write-at-a-time backpressure. */
  private appendQueue: Promise<void> = Promise.resolve();
  private pumpRequested = false;
  private finishing = false;
  private finishPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private failure: unknown = null;
  private provisionalMeta: RecordingStreamMeta | null = null;
  private started = false;
  private aborted = false;
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
      version: 4,
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
    this.provisionalMeta = meta;
    this.lastSession = session;
    this.writer.writeHeader(meta);
    this.started = true;
    this.appendQueue = this.appendQueue
      .then(() => this.flush())
      .catch((error) => this.handleFailure(error));
  }

  /** Appends records captured since the previous sync and forwards the new bytes. */
  sync(session: RecordingSession): void {
    if (!this.started) return;
    this.lastSession = session;
    this.requestPump();
  }

  /** Flushes any buffered tail, finalizes the stream (footer), and closes the sink. */
  finish(recording?: Recording): Promise<void> {
    if (!this.finishPromise) {
      this.finishPromise = this.finishInternal(recording).catch(async (error) => {
        await this.handleFailure(error);
        throw error;
      });
    }
    return this.finishPromise;
  }

  private async finishInternal(recording?: Recording): Promise<void> {
    this.finishing = true;

    if (!this.started) {
      await this.closeSink();
      return;
    }

    await this.appendQueue;

    if (this.failure) {
      await this.closeSink();
      throw this.failure;
    }

    if (this.lastSession) {
      await this.writeSegments(this.collectSessionSegments(this.lastSession, true));
    }

    const finalMeta = recording
      ? createRecordingStreamMeta(recording)
      : this.provisionalMeta && this.lastSession
        ? {
            ...this.provisionalMeta,
            duration: Math.max(performance.now() - this.lastSession.startedAtPerf, 1),
          }
        : null;

    if (finalMeta) {
      this.writer.appendFinalMetadata(finalMeta);
      await this.flush();
    }

    this.writer.finalizeStream();
    await this.flush();
    await this.closeSink();
  }

  /** Closes the sink without finalizing (e.g. on unmount mid-recording). */
  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    void this.appendQueue.then(() => this.closeSink()).catch((error) => this.handleFailure(error));
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
      ...this.collectEventSegments(
        SEGMENT_KIND.whiteboard,
        session.whiteboardEvents,
        "whiteboard",
        final,
      ),
      ...this.collectEventSegments(SEGMENT_KIND.chat, session.chatEvents, "chat", final),
    ];
  }

  private requestPump(): void {
    if (this.pumpRequested || this.finishing || this.aborted) return;
    this.pumpRequested = true;

    this.appendQueue = this.appendQueue
      .then(async () => {
        while (this.pumpRequested && !this.finishing && !this.aborted) {
          this.pumpRequested = false;
          const session = this.lastSession;

          if (session) {
            await this.writeSegments(this.collectSessionSegments(session, false));
          }
        }
      })
      .catch((error) => this.handleFailure(error));
  }

  private async writeSegments(segments: PendingStreamSegment[]): Promise<void> {
    if (segments.length === 0 || this.aborted) return;
    const orderedSegments = [...segments].sort(
      (left, right) =>
        left.clusterIndex - right.clusterIndex ||
        left.startTimeMs - right.startTimeMs ||
        left.priority - right.priority,
    );

    for (const segment of orderedSegments) {
      if (this.aborted) break;
      await segment.write();
      if (this.aborted) break;
      await this.flush();
    }
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

  private async flush(): Promise<void> {
    const bytes = this.writer.drainPending();
    if (bytes.length === 0) return;
    await this.sink.write(bytes);
  }

  private async closeSink(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = Promise.resolve().then(() => this.sink.close());
    }
    await this.closePromise;
  }

  private async handleFailure(error: unknown): Promise<void> {
    if (!this.failure) {
      this.failure = error;
      this.aborted = true;

      try {
        await this.sink.onError?.(error);
      } catch {
        // The original write/encode failure remains authoritative.
      }
    }

    try {
      await this.closeSink();
    } catch {
      // Closing is best-effort after the stream has already failed.
    }
  }
}
