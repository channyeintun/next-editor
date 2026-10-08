import { expose, transfer } from "comlink";
import { decompressBinaryToRecording, encodeRecordingToStream } from "./recordingCodec";
import type { DecodedRecording } from "./streamingRecordingCodec";

const transferUint8Array = (data: Uint8Array): Uint8Array => {
  return transfer(data, [data.buffer as ArrayBuffer]);
};

const transferRecording = (recording: DecodedRecording): DecodedRecording => {
  const buffers = (recording.workspaceAssets ?? []).map(
    (asset) => asset.bytes.buffer as ArrayBuffer,
  );
  return transfer(recording, buffers);
};

const api = {
  async decompressBinaryToRecording(binaryData: Uint8Array): Promise<DecodedRecording> {
    return transferRecording(await decompressBinaryToRecording(binaryData));
  },
  async encodeRecordingToStream(recording: DecodedRecording): Promise<Uint8Array> {
    return transferUint8Array(await encodeRecordingToStream(recording));
  },
};

export type RecordingCodecWorkerApi = typeof api;

expose(api);
