import { transfer, wrap, type Remote } from "comlink";
import type { Recording } from "../core/src";
import type { DeltaFrame } from "../core/src/utils/deltaTypes";
import type { WorkspaceRecordingAsset } from "../types/workspace";
import { loadDmpCodec } from "./dmpCodec/dmpCodec";
import {
  decompressBinaryToRecordings as decompressBinaryToRecordingsInProcess,
  encodeRecordingToStream as encodeRecordingToStreamInProcess,
  normalizeRecording,
} from "./recordingCodec";
import type { RecordingCodecWorkerApi } from "./recordingCodec.worker";
import {
  createStreamingRecordingWriter,
  type RecordingStreamMeta,
  type SegmentKind,
  type StreamingRecordingWriter,
  type StreamingSegmentAppendOptions,
} from "./streamingRecordingCodec";
import { startPerformanceSpan } from "../utils/performanceMetrics";
import { hydrateDecodedRecordingWorkspaceAssets } from "./recordingWorkspaceAssets";

interface RecordingCodecWorkerClient {
  api: Remote<RecordingCodecWorkerApi>;
  worker: Worker;
  /**
   * Rejects when the worker dies. Comlink settles a call only on a reply
   * message, so a worker that fails after construction leaves every call
   * pending forever — and this module has a working in-process fallback one
   * branch away that a hang can never reach.
   */
  failed: Promise<never>;
}

let workerClient: RecordingCodecWorkerClient | null = null;
let workerUnavailable = false;
let liveStreamId = 0;

function canUseRecordingCodecWorker(): boolean {
  return !workerUnavailable && typeof window !== "undefined" && typeof Worker !== "undefined";
}

function getRecordingCodecWorkerClient(): RecordingCodecWorkerClient | null {
  if (!canUseRecordingCodecWorker()) {
    return null;
  }

  if (!workerClient) {
    let worker: Worker;

    try {
      worker = new Worker(new URL("./recordingCodec.worker.ts", import.meta.url), {
        name: "next-editor-recording-codec",
        type: "module",
      });
    } catch {
      workerUnavailable = true;
      return null;
    }

    // The constructor only throws for a synchronously rejected worker; one whose
    // module fails at runtime constructs fine and then fires `error`.
    let failWorker: (error: Error) => void = () => {};
    const failed = new Promise<never>((_, reject) => {
      failWorker = reject;
    });
    failed.catch(() => {});
    const onWorkerFailure = () => {
      workerUnavailable = true;
      workerClient = null;
      worker.terminate();
      failWorker(new Error("Recording codec worker failed"));
    };
    worker.addEventListener("error", onWorkerFailure);
    worker.addEventListener("messageerror", onWorkerFailure);

    workerClient = {
      api: wrap<RecordingCodecWorkerApi>(worker),
      worker,
      failed,
    };
  }

  return workerClient;
}

/** Races a worker call against the worker's own death, so callers can fall back. */
function callCodecWorker<T>(client: RecordingCodecWorkerClient, call: Promise<T>): Promise<T> {
  return Promise.race([call, client.failed]);
}

function transferUint8Array(data: Uint8Array): Uint8Array {
  return transfer(data, [data.buffer as ArrayBuffer]);
}

export { normalizeRecording };

export interface LiveRecordingStreamEncoder {
  start(meta: RecordingStreamMeta): Promise<Uint8Array>;
  appendFrameSegment(
    frames: DeltaFrame[],
    options?: StreamingSegmentAppendOptions,
  ): Promise<Uint8Array>;
  appendEventSegment(
    kind: SegmentKind,
    records: unknown[],
    options?: StreamingSegmentAppendOptions,
  ): Promise<Uint8Array>;
  appendWorkspaceAssetSegment(
    asset: WorkspaceRecordingAsset,
    options?: StreamingSegmentAppendOptions,
  ): Promise<Uint8Array>;
  finalize(finalMeta?: RecordingStreamMeta): Promise<Uint8Array>;
  abort(): Promise<void>;
}

class LiveRecordingStreamEncoderClient implements LiveRecordingStreamEncoder {
  private readonly streamId = `live-${Date.now()}-${++liveStreamId}`;
  private readonly remote: Remote<RecordingCodecWorkerApi> | null;
  private readonly localWriter: StreamingRecordingWriter | null;
  private operationQueue: Promise<void> = Promise.resolve();
  private nextSequence = 0;
  private started = false;
  private finished = false;

  constructor(client: RecordingCodecWorkerClient | null) {
    this.remote = client?.api ?? null;
    this.localWriter = this.remote ? null : createStreamingRecordingWriter();
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private enqueueCodecOperation<T>(
    kind: "asset" | "event" | "finalize" | "frame" | "header",
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const endSpan = startPerformanceSpan("recording.segment_codec_roundtrip", {
      kind,
      worker: this.remote !== null,
    });
    return this.enqueue(async () => {
      let outcome = "success";
      try {
        return await operation();
      } catch (error) {
        outcome = "failure";
        throw error;
      } finally {
        endSpan({ outcome });
      }
    });
  }

  private drainLocal(): Uint8Array {
    if (!this.localWriter) throw new Error("Local live recording writer is unavailable");
    return this.localWriter.drainPending();
  }

  start(meta: RecordingStreamMeta): Promise<Uint8Array> {
    return this.enqueueCodecOperation("header", async () => {
      if (this.started || this.finished) throw new Error("Live recording stream already started");
      this.started = true;
      if (this.remote) return this.remote.startLiveRecordingStream(this.streamId, meta);
      this.localWriter!.writeHeader(meta);
      return this.drainLocal();
    });
  }

  appendFrameSegment(
    frames: DeltaFrame[],
    options?: StreamingSegmentAppendOptions,
  ): Promise<Uint8Array> {
    return this.enqueueCodecOperation("frame", async () => {
      this.ensureWritable();
      const sequence = this.nextSequence;
      const bytes = this.remote
        ? await this.remote.appendLiveFrameSegment(this.streamId, sequence, frames, options)
        : (() => {
            this.localWriter!.appendFrameSegment(frames, options);
            return this.drainLocal();
          })();
      this.nextSequence += 1;
      return bytes;
    });
  }

  appendEventSegment(
    kind: SegmentKind,
    records: unknown[],
    options?: StreamingSegmentAppendOptions,
  ): Promise<Uint8Array> {
    return this.enqueueCodecOperation("event", async () => {
      this.ensureWritable();
      const sequence = this.nextSequence;
      const bytes = this.remote
        ? await this.remote.appendLiveEventSegment(this.streamId, sequence, kind, records, options)
        : (() => {
            this.localWriter!.appendEventSegment(kind, records, options);
            return this.drainLocal();
          })();
      this.nextSequence += 1;
      return bytes;
    });
  }

  appendWorkspaceAssetSegment(
    asset: WorkspaceRecordingAsset,
    options?: StreamingSegmentAppendOptions,
  ): Promise<Uint8Array> {
    return this.enqueueCodecOperation("asset", async () => {
      this.ensureWritable();
      const sequence = this.nextSequence;
      const bytes = this.remote
        ? await this.remote.appendLiveWorkspaceAssetSegment(
            this.streamId,
            sequence,
            asset.descriptor,
            transferUint8Array(asset.bytes),
            options,
          )
        : (() => {
            this.localWriter!.appendWorkspaceAssetSegment(asset, options);
            return this.drainLocal();
          })();
      this.nextSequence += 1;
      return bytes;
    });
  }

  finalize(finalMeta?: RecordingStreamMeta): Promise<Uint8Array> {
    return this.enqueueCodecOperation("finalize", async () => {
      this.ensureWritable();
      let bytes: Uint8Array;
      if (this.remote) {
        bytes = await this.remote.finishLiveRecordingStream(
          this.streamId,
          this.nextSequence,
          finalMeta,
        );
      } else {
        if (finalMeta) this.localWriter!.appendFinalMetadata(finalMeta);
        this.localWriter!.finalizeStream();
        bytes = this.drainLocal();
      }
      this.finished = true;
      return bytes;
    });
  }

  abort(): Promise<void> {
    return this.enqueue(async () => {
      if (this.finished) return;
      if (this.remote && this.started) {
        await this.remote.abortLiveRecordingStream(this.streamId);
      }
      this.finished = true;
    });
  }

  private ensureWritable(): void {
    if (!this.started) throw new Error("Live recording stream has not started");
    if (this.finished) throw new Error("Live recording stream is already closed");
  }
}

export function createLiveRecordingStreamEncoder(): LiveRecordingStreamEncoder {
  return new LiveRecordingStreamEncoderClient(getRecordingCodecWorkerClient());
}

export async function decompressBinaryToRecordings(binaryData: Uint8Array): Promise<Recording[]> {
  // The worker decodes, but the main thread reconstructs frames synchronously
  // during replay (applyContentDelta → diff-match-patch), so the codec must be
  // loaded here regardless of whether the worker is used.
  await loadDmpCodec();
  const client = getRecordingCodecWorkerClient();

  // A dead worker falls back in process rather than stranding the decode — the
  // whole point of keeping the in-process implementation around.
  const recordings = client
    ? await callCodecWorker(
        client,
        client.api.decompressBinaryToRecordings(transferUint8Array(binaryData)),
      ).catch(() => decompressBinaryToRecordingsInProcess(binaryData))
    : await decompressBinaryToRecordingsInProcess(binaryData);
  return Promise.all(recordings.map(hydrateDecodedRecordingWorkspaceAssets));
}

export async function encodeRecordingToStream(recording: Recording): Promise<Uint8Array> {
  await loadDmpCodec();
  const client = getRecordingCodecWorkerClient();

  if (!client || recording.workspaceAssets?.length || typeof indexedDB === "undefined") {
    return encodeRecordingToStreamInProcess(recording);
  }

  return callCodecWorker(client, client.api.encodeRecordingToStream(recording)).catch(() =>
    encodeRecordingToStreamInProcess(recording),
  );
}
