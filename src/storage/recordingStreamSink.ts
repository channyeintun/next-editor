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
  /** Serializes async audio reads/appends so fragments stay in arrival order. */
  private audioQueue: Promise<void> = Promise.resolve();
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
    this.flushFrames(session.frames, false);
    this.flushEvents(SEGMENT_KIND.slide, session.slideEvents, "slide", false);
    this.flushEvents(SEGMENT_KIND.preview, session.previewEvents, "preview", false);
    this.flushEvents(SEGMENT_KIND.previewDoc, session.previewInitialDocuments, "previewDoc", false);
    this.flushEvents(SEGMENT_KIND.previewPatch, session.previewPatchBatches, "previewPatch", false);
    this.flushEvents(SEGMENT_KIND.workspace, session.workspaceEvents, "workspace", false);
    this.flushEvents(SEGMENT_KIND.runtime, session.runtimeEvents, "runtime", false);
    this.flushEvents(SEGMENT_KIND.cursor, session.cursorEvents, "cursor", false);
    this.flush();
    this.queueAudio(session.audioFragments);
    this.queueCamera(session.cameraFragments);
  }

  /** Flushes any buffered tail, finalizes the stream (footer), and closes the sink. */
  async finish(): Promise<void> {
    if (!this.started) {
      await this.closeSink();
      return;
    }
    if (this.lastSession) {
      const session = this.lastSession;
      this.flushFrames(session.frames, true);
      this.flushEvents(SEGMENT_KIND.slide, session.slideEvents, "slide", true);
      this.flushEvents(SEGMENT_KIND.preview, session.previewEvents, "preview", true);
      this.flushEvents(
        SEGMENT_KIND.previewDoc,
        session.previewInitialDocuments,
        "previewDoc",
        true,
      );
      this.flushEvents(
        SEGMENT_KIND.previewPatch,
        session.previewPatchBatches,
        "previewPatch",
        true,
      );
      this.flushEvents(SEGMENT_KIND.workspace, session.workspaceEvents, "workspace", true);
      this.flushEvents(SEGMENT_KIND.runtime, session.runtimeEvents, "runtime", true);
      this.flushEvents(SEGMENT_KIND.cursor, session.cursorEvents, "cursor", true);
      this.flush();
      this.queueAudio(session.audioFragments);
      this.queueCamera(session.cameraFragments);
    }
    // All media must be appended before the footer so the finalized stream is complete.
    await this.audioQueue;
    await this.cameraQueue;
    this.writer.finalize();
    this.flush();
    await this.closeSink();
  }

  /** Closes the sink without finalizing (e.g. on unmount mid-recording). */
  abort(): void {
    void this.closeSink();
  }

  private flushFrames(frames: RecordingSession["frames"], final: boolean): void {
    // Emit a segment for each completed keyframe-bounded run; keep the trailing run
    // buffered until its next keyframe arrives (or until finish).
    for (let index = this.counts.frames + 1; index < frames.length; index++) {
      if (isKeyframe(frames[index])) {
        this.writer.appendFrameSegment(frames.slice(this.counts.frames, index));
        this.counts.frames = index;
      }
    }
    if (final && this.counts.frames < frames.length) {
      this.writer.appendFrameSegment(frames.slice(this.counts.frames));
      this.counts.frames = frames.length;
    }
  }

  private flushEvents(
    kind: (typeof SEGMENT_KIND)[keyof typeof SEGMENT_KIND],
    records: ReadonlyArray<unknown>,
    key: keyof StreamedCounts,
    final: boolean,
  ): void {
    const pending = records.length - this.counts[key];
    if (pending <= 0) return;
    if (!final && pending < EVENT_FLUSH_THRESHOLD) return;
    this.writer.appendEventSegment(kind, records.slice(this.counts[key]));
    this.counts[key] = records.length;
  }

  private queueAudio(fragments: RecordingSession["audioFragments"]): void {
    while (this.audioCount < fragments.length) {
      const fragment = fragments[this.audioCount];
      this.audioCount += 1;
      // Append + flush run together inside one queued task so no other append interleaves
      // between a fragment and its drain, keeping the emitted byte stream ordered.
      this.audioQueue = this.audioQueue.then(async () => {
        const bytes = await blobToBytes(fragment.blob);
        this.writer.appendAudioChunk(bytes, {
          startTimeMs: fragment.startTimeMs,
          endTimeMs: fragment.endTimeMs,
        });
        this.flush();
      });
    }
  }

  /** Serializes async camera reads/appends so fragments stay in arrival order. */
  private cameraQueue: Promise<void> = Promise.resolve();

  private queueCamera(fragments: RecordingSession["cameraFragments"]): void {
    while (this.cameraCount < fragments.length) {
      const fragment = fragments[this.cameraCount];
      this.cameraCount += 1;
      this.cameraQueue = this.cameraQueue.then(async () => {
        const bytes = await blobToBytes(fragment.blob);
        this.writer.appendCameraChunk(bytes, {
          startTimeMs: fragment.startTimeMs,
          endTimeMs: fragment.endTimeMs,
        });
        this.flush();
      });
    }
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
