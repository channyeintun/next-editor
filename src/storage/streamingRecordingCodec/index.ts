// SCR3 recording stream container — public API.
//
// The implementation is split by concern:
//   * format.ts  — the on-wire byte layout (constants, structs, field primitives)
//   * clusters.ts — deriving tracks/clusters/media fragments from a Recording
//   * encode.ts  — Recording → bytes (live writer + one-shot exporter)
//   * decode.ts  — bytes → Recording (one-shot decoder + incremental reader)
//
// This module simply re-exports the public surface so callers keep importing from
// "streamingRecordingCodec" unchanged.

export {
  SEGMENT_KIND,
  RECORDING_EVENT_SEGMENTS,
  isStreamingRecording,
  readRecordTimestamp,
  audioMimeFromFilename,
} from "./format";
export type { RecordingEventSegmentKey, SegmentKind, RecordingStreamMeta } from "./format";

export {
  createRecordingStreamMeta,
  createStreamingRecordingWriter,
  encodeRecordingToStream,
} from "./encode";
export type { StreamingRecordingWriter, StreamingSegmentAppendOptions } from "./encode";

export { decodeRecordingStream, createStreamingRecordingReader } from "./decode";
export type { StreamingRecordingDelta, StreamingRecordingReader } from "./decode";
