import type { Recording, RecordingStreamSink } from "../core/src/types";
import type { RecordingSession } from "../core/src/machine/types";
import type { WorkspaceAssetDescriptor } from "../types/workspace";
import { DELTA_CONFIG } from "../core/src/utils/deltaTypes";
import { isKeyframe } from "../core/src/utils/deltaTypes";
import {
  SEGMENT_KIND,
  RECORDING_EVENT_SEGMENTS,
  createRecordingStreamMeta,
  readRecordTimestamp,
  type RecordingStreamMeta,
  type RecordingEventSegmentKey,
} from "./streamingRecordingCodec";
import {
  createLiveRecordingStreamEncoder,
  type LiveRecordingStreamEncoder,
} from "./recordingCodecClient";
import {
  collectRecordingWorkspaceAssetDescriptors,
  collectWorkspaceEventAssetDescriptors,
} from "./recordingWorkspaceAssets";
import { getWorkspaceAssetBytes } from "./workspaceAssetStore";

/**
 * Flush event segments once this many new records have accumulated (or on finish), so
 * high-cadence streams like cursor samples don't produce a deflate segment per record.
 */
const EVENT_FLUSH_THRESHOLD = 32;

type StreamedCounts = {
  frames: number;
} & Record<RecordingEventSegmentKey, number>;

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
  write: () => Promise<Uint8Array[]>;
}

/**
 * Bridges an in-progress `RecordingSession` to a {@link RecordingStreamSink} by appending
 * newly-captured records to a live SCR3 writer and forwarding the drained bytes.
 *
 * Frame segments are flushed at keyframe boundaries (range-loadable) and event segments on a
 * small threshold, matching the SCR3 batching policy. Audio and camera stay in sibling files;
 * content-addressed workspace assets are emitted once as raw segments before their first
 * referencing workspace event. The emitted bytes are the same SCR3 stream the exporter produces,
 * so a remote consumer can replay them with `decodeRecordingStream`.
 */
export class RecordingStreamBridge {
  private readonly codec: LiveRecordingStreamEncoder = createLiveRecordingStreamEncoder();
  private readonly counts = {
    frames: 0,
    ...Object.fromEntries(RECORDING_EVENT_SEGMENTS.map(({ key }) => [key, 0])),
  } as StreamedCounts;
  /** Timeline starts for SCR3 cluster indices known to the live bridge. */
  private readonly clusterStarts: number[] = [];
  private readonly streamedWorkspaceAssetIds = new Set<string>();
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
    this.started = true;
    this.appendQueue = this.appendQueue
      .then(async () => this.writeBytes(await this.codec.start(meta)))
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

    if (recording) {
      await this.writeMissingWorkspaceAssets(
        collectRecordingWorkspaceAssetDescriptors(recording),
        0,
        0,
      );
    }

    const finalMeta = recording
      ? createRecordingStreamMeta(recording)
      : this.provisionalMeta && this.lastSession
        ? {
            ...this.provisionalMeta,
            duration: Math.max(performance.now() - this.lastSession.startedAtPerf, 1),
          }
        : null;

    await this.writeBytes(await this.codec.finalize(finalMeta ?? undefined));
    await this.closeSink();
  }

  /** Closes the sink without finalizing (e.g. on unmount mid-recording). */
  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    void this.appendQueue
      .then(async () => {
        await this.codec.abort();
        await this.closeSink();
      })
      .catch((error) => this.handleFailure(error));
  }

  private collectSessionSegments(
    session: RecordingSession,
    final: boolean,
  ): PendingStreamSegment[] {
    return [
      ...this.collectFrameSegments(session.frames, final),
      ...RECORDING_EVENT_SEGMENTS.flatMap(({ kind, key }) =>
        this.collectEventSegments(kind, session[key], key, final),
      ),
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
      const chunks = await segment.write();
      for (const bytes of chunks) {
        if (this.aborted) break;
        await this.writeBytes(bytes);
      }
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
      write: async () => [
        await this.codec.appendFrameSegment(frames, {
          startTimeMs,
          endTimeMs: Math.max(startTimeMs, endTimeMs),
          clusterIndex,
          containsKeyframe: frames.some(isKeyframe),
        }),
      ],
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
    key: RecordingEventSegmentKey,
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
        write: async () => {
          const chunks =
            kind === SEGMENT_KIND.workspace
              ? await this.encodeMissingWorkspaceAssets(
                  collectWorkspaceEventAssetDescriptors(group),
                  firstTimestamp,
                  clusterIndex,
                )
              : [];
          chunks.push(
            await this.codec.appendEventSegment(kind, group, {
              startTimeMs: firstTimestamp,
              endTimeMs: readRecordTimestamp(group[group.length - 1]),
              clusterIndex,
            }),
          );
          return chunks;
        },
      });
      groupStart = groupEnd;
    }
    this.counts[key] = records.length;
    return segments;
  }

  private async encodeMissingWorkspaceAssets(
    descriptors: WorkspaceAssetDescriptor[],
    startTimeMs: number,
    clusterIndex: number,
  ): Promise<Uint8Array[]> {
    const chunks: Uint8Array[] = [];
    for (const descriptor of descriptors) {
      if (this.streamedWorkspaceAssetIds.has(descriptor.assetId)) continue;
      const bytes = await getWorkspaceAssetBytes(descriptor);
      chunks.push(
        await this.codec.appendWorkspaceAssetSegment(
          { descriptor, bytes },
          { startTimeMs, endTimeMs: startTimeMs, clusterIndex },
        ),
      );
      this.streamedWorkspaceAssetIds.add(descriptor.assetId);
    }
    return chunks;
  }

  private async writeMissingWorkspaceAssets(
    descriptors: WorkspaceAssetDescriptor[],
    startTimeMs: number,
    clusterIndex: number,
  ): Promise<void> {
    for (const chunk of await this.encodeMissingWorkspaceAssets(
      descriptors,
      startTimeMs,
      clusterIndex,
    )) {
      await this.writeBytes(chunk);
    }
  }

  private async writeBytes(bytes: Uint8Array): Promise<void> {
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
        await this.codec.abort();
      } catch {
        // The original write/encode failure remains authoritative.
      }

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
