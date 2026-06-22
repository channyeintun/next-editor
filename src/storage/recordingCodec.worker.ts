import { expose, transfer } from "comlink";
import type { Recording } from "../core/src";
import { loadGoCodec } from "./goCodec/goCodec";
import {
  decodeBase64ToRecordings,
  decompressBinaryToRecordings,
  encodeRecordingToBase64Stream,
  encodeRecordingToStream,
} from "./recordingCodec";

const transferUint8Array = (data: Uint8Array): Uint8Array => {
  return transfer(data, [data.buffer as ArrayBuffer]);
};

const api = {
  async decompressBinaryToRecordings(binaryData: Uint8Array): Promise<Recording[]> {
    await loadGoCodec();
    return decompressBinaryToRecordings(binaryData);
  },
  async decodeBase64ToRecordings(base64Data: string): Promise<Recording[]> {
    await loadGoCodec();
    return decodeBase64ToRecordings(base64Data);
  },
  async encodeRecordingToStream(recording: Recording): Promise<Uint8Array> {
    await loadGoCodec();
    return transferUint8Array(await encodeRecordingToStream(recording));
  },
  async encodeRecordingToBase64Stream(recording: Recording): Promise<string> {
    await loadGoCodec();
    return encodeRecordingToBase64Stream(recording);
  },
};

export type RecordingCodecWorkerApi = typeof api;

expose(api);
