import { expose, transfer } from "comlink";
import type { Recording } from "../core/src";
import type { DeltaFrame } from "../core/src/utils/deltaTypes";
import type { WorkspaceAssetDescriptor } from "../types/workspace";
import { loadDmpCodec } from "./dmpCodec/dmpCodec";
import { decompressBinaryToRecordings, encodeRecordingToStream } from "./recordingCodec";
import {
  createStreamingRecordingWriter,
  type RecordingStreamMeta,
  type SegmentKind,
  type StreamingRecordingWriter,
  type StreamingSegmentAppendOptions,
} from "./streamingRecordingCodec";

const transferUint8Array = (data: Uint8Array): Uint8Array => {
  return transfer(data, [data.buffer as ArrayBuffer]);
};

const transferRecordings = (recordings: Recording[]): Recording[] => {
  const buffers = recordings.flatMap((recording) =>
    (recording.workspaceAssets ?? []).map((asset) => asset.bytes.buffer as ArrayBuffer),
  );
  return transfer(recordings, buffers);
};

interface LiveWriterState {
  writer: StreamingRecordingWriter;
  nextSequence: number;
}

const liveWriters = new Map<string, LiveWriterState>();

function liveWriter(streamId: string, sequence: number): LiveWriterState {
  const state = liveWriters.get(streamId);
  if (!state) throw new Error("Live recording codec stream is not open");
  if (sequence !== state.nextSequence) {
    throw new Error(
      `Live recording codec sequence mismatch: expected ${state.nextSequence}, received ${sequence}`,
    );
  }
  return state;
}

function drainLiveWriter(state: LiveWriterState): Uint8Array {
  state.nextSequence += 1;
  return transferUint8Array(state.writer.drainPending());
}

const api = {
  async decompressBinaryToRecordings(binaryData: Uint8Array): Promise<Recording[]> {
    await loadDmpCodec();
    return transferRecordings(await decompressBinaryToRecordings(binaryData));
  },
  async encodeRecordingToStream(recording: Recording): Promise<Uint8Array> {
    await loadDmpCodec();
    return transferUint8Array(await encodeRecordingToStream(recording));
  },
  startLiveRecordingStream(streamId: string, meta: RecordingStreamMeta): Uint8Array {
    if (liveWriters.has(streamId)) throw new Error("Live recording codec stream already exists");
    const writer = createStreamingRecordingWriter();
    writer.writeHeader(meta);
    const state = { writer, nextSequence: 0 } satisfies LiveWriterState;
    liveWriters.set(streamId, state);
    return transferUint8Array(writer.drainPending());
  },
  appendLiveFrameSegment(
    streamId: string,
    sequence: number,
    frames: DeltaFrame[],
    options?: StreamingSegmentAppendOptions,
  ): Uint8Array {
    const state = liveWriter(streamId, sequence);
    state.writer.appendFrameSegment(frames, options);
    return drainLiveWriter(state);
  },
  appendLiveEventSegment(
    streamId: string,
    sequence: number,
    kind: SegmentKind,
    records: unknown[],
    options?: StreamingSegmentAppendOptions,
  ): Uint8Array {
    const state = liveWriter(streamId, sequence);
    state.writer.appendEventSegment(kind, records, options);
    return drainLiveWriter(state);
  },
  appendLiveWorkspaceAssetSegment(
    streamId: string,
    sequence: number,
    descriptor: WorkspaceAssetDescriptor,
    bytes: Uint8Array,
    options?: StreamingSegmentAppendOptions,
  ): Uint8Array {
    const state = liveWriter(streamId, sequence);
    state.writer.appendWorkspaceAssetSegment({ descriptor, bytes }, options);
    return drainLiveWriter(state);
  },
  finishLiveRecordingStream(
    streamId: string,
    sequence: number,
    finalMeta?: RecordingStreamMeta,
  ): Uint8Array {
    const state = liveWriter(streamId, sequence);
    try {
      if (finalMeta) state.writer.appendFinalMetadata(finalMeta);
      state.writer.finalizeStream();
      return transferUint8Array(state.writer.drainPending());
    } finally {
      liveWriters.delete(streamId);
    }
  },
  abortLiveRecordingStream(streamId: string): void {
    liveWriters.delete(streamId);
  },
};

export type RecordingCodecWorkerApi = typeof api;

expose(api);
