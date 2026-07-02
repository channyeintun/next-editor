import { transfer, wrap, type Remote } from "comlink";
import type { Recording } from "../core/src";
import { loadDmpCodec } from "./dmpCodec/dmpCodec";
import {
  decompressBinaryToRecordings as decompressBinaryToRecordingsInProcess,
  encodeRecordingToStream as encodeRecordingToStreamInProcess,
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

export async function decompressBinaryToRecordings(binaryData: Uint8Array): Promise<Recording[]> {
  // The worker decodes, but the main thread reconstructs frames synchronously
  // during replay (applyContentDelta → diff-match-patch), so the codec must be
  // loaded here regardless of whether the worker is used.
  await loadDmpCodec();
  const client = getRecordingCodecWorkerClient();

  if (!client) {
    return decompressBinaryToRecordingsInProcess(binaryData);
  }

  return client.api.decompressBinaryToRecordings(transferUint8Array(binaryData));
}

export async function encodeRecordingToStream(recording: Recording): Promise<Uint8Array> {
  await loadDmpCodec();
  const client = getRecordingCodecWorkerClient();

  if (!client) {
    return encodeRecordingToStreamInProcess(recording);
  }

  return client.api.encodeRecordingToStream(recording);
}
