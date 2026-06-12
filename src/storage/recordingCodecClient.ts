import { transfer, wrap, type Remote } from "comlink";
import type { Recording } from "../core/src";
import {
  compressRecordingsToBinary as compressRecordingsToBinaryInProcess,
  decodeBase64ToRecordings as decodeBase64ToRecordingsInProcess,
  decompressBinaryToRecordings as decompressBinaryToRecordingsInProcess,
  encodeRecordingsToBase64 as encodeRecordingsToBase64InProcess,
  normalizeRecording,
} from "./recordingCodec";
import type { RecordingCodecWorkerApi } from "./recordingCodec.worker";

interface RecordingCodecWorkerClient {
  api: Remote<RecordingCodecWorkerApi>;
  worker: Worker;
}

let workerClient: RecordingCodecWorkerClient | null = null;
let workerUnavailable = false;

function canUseRecordingCodecWorker(): boolean {
  return !workerUnavailable && typeof window !== "undefined" && typeof Worker !== "undefined";
}

function getRecordingCodecWorkerClient(): RecordingCodecWorkerClient | null {
  if (!canUseRecordingCodecWorker()) {
    return null;
  }

  if (!workerClient) {
    let worker: Worker;

    try {
      worker = new Worker(new URL("./recordingCodec.worker.ts", import.meta.url), {
        name: "next-editor-recording-codec",
        type: "module",
      });
    } catch {
      workerUnavailable = true;
      return null;
    }

    workerClient = {
      api: wrap<RecordingCodecWorkerApi>(worker),
      worker,
    };
  }

  return workerClient;
}

function transferUint8Array(data: Uint8Array): Uint8Array {
  return transfer(data, [data.buffer as ArrayBuffer]);
}

export { normalizeRecording };

export async function compressRecordingsToBinary(recordings: Recording[]): Promise<Uint8Array> {
  const client = getRecordingCodecWorkerClient();

  if (!client) {
    return compressRecordingsToBinaryInProcess(recordings);
  }

  return client.api.compressRecordingsToBinary(recordings);
}

export async function decompressBinaryToRecordings(binaryData: Uint8Array): Promise<Recording[]> {
  const client = getRecordingCodecWorkerClient();

  if (!client) {
    return decompressBinaryToRecordingsInProcess(binaryData);
  }

  return client.api.decompressBinaryToRecordings(transferUint8Array(binaryData));
}

export async function encodeRecordingsToBase64(recordings: Recording[]): Promise<string> {
  const client = getRecordingCodecWorkerClient();

  if (!client) {
    return encodeRecordingsToBase64InProcess(recordings);
  }

  return client.api.encodeRecordingsToBase64(recordings);
}

export async function decodeBase64ToRecordings(base64Data: string): Promise<Recording[]> {
  const client = getRecordingCodecWorkerClient();

  if (!client) {
    return decodeBase64ToRecordingsInProcess(base64Data);
  }

  return client.api.decodeBase64ToRecordings(base64Data);
}
