import { expose, transfer } from "comlink";
import type { Recording } from "../core/src";
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
    return decompressBinaryToRecordings(binaryData);
  },
  async decodeBase64ToRecordings(base64Data: string): Promise<Recording[]> {
    return decodeBase64ToRecordings(base64Data);
  },
  async encodeRecordingToStream(recording: Recording): Promise<Uint8Array> {
    return transferUint8Array(await encodeRecordingToStream(recording));
  },
  async encodeRecordingToBase64Stream(recording: Recording): Promise<string> {
    return encodeRecordingToBase64Stream(recording);
  },
};

export type RecordingCodecWorkerApi = typeof api;

expose(api);
