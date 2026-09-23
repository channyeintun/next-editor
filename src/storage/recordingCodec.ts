import type { Recording } from "../core/src";
import { normalizeRecordingData } from "../core/src/utils/editorState";
import {
  decodeRecordingStream,
  encodeRecordingToStream,
  isStreamingRecording,
} from "./streamingRecordingCodec";

export { encodeRecordingToStream };

export function normalizeRecording(recording: Recording): Recording {
  if (recording.version === 4) {
    return normalizeRecordingData(recording);
  }

  throw new Error(
    `Unsupported recording version: ${(recording as Recording & { version?: unknown }).version ?? "unknown"}`,
  );
}

export async function decompressBinaryToRecording(binaryData: Uint8Array): Promise<Recording> {
  if (!isStreamingRecording(binaryData)) {
    throw new Error("Invalid recording format: expected an SCR3 stream");
  }

  // An SCR3 stream holds exactly one recording. Decoding is tolerant of an in-progress
  // footer or truncated trailing segment, so callers can progressively decode larger
  // binary prefixes during download.
  return decodeRecordingStream(binaryData);
}
