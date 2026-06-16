import type { Recording } from "../core/src";
import { decodeBase64, encodeBase64 } from "../core/src/utils/base64";
import { normalizeRecordingData } from "../core/src/utils/editorState";
import {
  decodeRecordingPrefix,
  encodeRecordingToStream,
  isStreamingRecording,
} from "./streamingRecordingCodec";

export { encodeRecordingToStream };

export function normalizeRecording(recording: Recording): Recording {
  if (recording.version === 2 || recording.version === 3) {
    return normalizeRecordingData(recording);
  }

  throw new Error(
    `Unsupported recording version: ${(recording as Recording & { version?: unknown }).version ?? "unknown"}`,
  );
}

export async function decompressBinaryToRecordings(binaryData: Uint8Array): Promise<Recording[]> {
  if (!isStreamingRecording(binaryData)) {
    throw new Error("Invalid recording format: expected an SCR3 stream");
  }

  // The SCR3 container holds a single recording per stream. Prefix decoding is
  // tolerant of an in-progress footer or truncated trailing segment, so callers
  // can progressively decode larger binary prefixes during download.
  return [decodeRecordingPrefix(binaryData)];
}

export async function decodeBase64ToRecordings(base64Data: string): Promise<Recording[]> {
  return decompressBinaryToRecordings(decodeBase64(base64Data));
}

/** Encodes a single recording to a base64-wrapped SCR3 stream (for `.ne` export). */
export async function encodeRecordingToBase64Stream(recording: Recording): Promise<string> {
  return encodeBase64(await encodeRecordingToStream(recording));
}
