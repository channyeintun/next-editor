import { expose, transfer } from "comlink";
import type { Recording } from "../core/src";
import { decompressBinaryToRecording, encodeRecordingToStream } from "./recordingCodec";

const transferUint8Array = (data: Uint8Array): Uint8Array => {
  return transfer(data, [data.buffer as ArrayBuffer]);
};

const transferRecording = (recording: Recording): Recording => {
  const buffers = (recording.workspaceAssets ?? []).map(
    (asset) => asset.bytes.buffer as ArrayBuffer,
  );
  return transfer(recording, buffers);
};

const api = {
  async decompressBinaryToRecording(binaryData: Uint8Array): Promise<Recording> {
    return transferRecording(await decompressBinaryToRecording(binaryData));
  },
  async encodeRecordingToStream(recording: Recording): Promise<Uint8Array> {
    return transferUint8Array(await encodeRecordingToStream(recording));
  },
};

export type RecordingCodecWorkerApi = typeof api;

expose(api);
