import { expose, transfer } from "comlink";
import type { Recording } from "../core/src";
import { loadDmpCodec } from "./dmpCodec/dmpCodec";
import { decompressBinaryToRecordings, encodeRecordingToStream } from "./recordingCodec";

const transferUint8Array = (data: Uint8Array): Uint8Array => {
  return transfer(data, [data.buffer as ArrayBuffer]);
};

const api = {
  async decompressBinaryToRecordings(binaryData: Uint8Array): Promise<Recording[]> {
    await loadDmpCodec();
    return decompressBinaryToRecordings(binaryData);
  },
  async encodeRecordingToStream(recording: Recording): Promise<Uint8Array> {
    await loadDmpCodec();
    return transferUint8Array(await encodeRecordingToStream(recording));
  },
};

export type RecordingCodecWorkerApi = typeof api;

expose(api);
