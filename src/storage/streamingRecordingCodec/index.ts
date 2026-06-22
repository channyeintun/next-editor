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

export { STREAM_MAGIC, SEGMENT_KIND, isStreamingRecording, readRecordTimestamp } from "./format";
export type { SegmentKind, RecordingStreamMeta } from "./format";

export { createStreamingRecordingWriter, encodeRecordingToStream } from "./encode";
export type { StreamingRecordingWriter } from "./encode";

export {
  decodeRecordingStream,
  decodeRecordingPrefix,
  createStreamingRecordingReader,
} from "./decode";
export type { StreamingRecordingReader } from "./decode";
