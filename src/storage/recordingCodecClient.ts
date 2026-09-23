import { wrap, type Remote } from "comlink";
import type { Recording } from "../core/src";
import { loadDmpCodec } from "./dmpCodec/dmpCodec";
import {
  decompressBinaryToRecording as decompressBinaryToRecordingInProcess,
  encodeRecordingToStream as encodeRecordingToStreamInProcess,
  normalizeRecording,
} from "./recordingCodec";
import type { RecordingCodecWorkerApi } from "./recordingCodec.worker";
import { hydrateDecodedRecordingWorkspaceAssets } from "./recordingWorkspaceAssets";

interface RecordingCodecWorkerClient {
  api: Remote<RecordingCodecWorkerApi>;
  worker: Worker;
  /**
   * Rejects when the worker dies. Comlink settles a call only on a reply
   * message, so a worker that fails after construction leaves every call
   * pending forever — and this module has a working in-process fallback one
   * branch away that a hang can never reach.
   */
  failed: Promise<never>;
}

/** The codec worker itself died, so the call it was running can be retried in process. */
class CodecWorkerFailedError extends Error {}

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

    // The constructor only throws for a synchronously rejected worker; one whose
    // module fails at runtime constructs fine and then fires `error`.
    let failWorker: (error: Error) => void = () => {};
    const failed = new Promise<never>((_, reject) => {
      failWorker = reject;
    });
    failed.catch(() => {});
    const onWorkerFailure = () => {
      workerUnavailable = true;
      workerClient = null;
      worker.terminate();
      failWorker(new CodecWorkerFailedError("Recording codec worker failed"));
    };
    worker.addEventListener("error", onWorkerFailure);
    worker.addEventListener("messageerror", onWorkerFailure);

    workerClient = {
      api: wrap<RecordingCodecWorkerApi>(worker),
      worker,
      failed,
    };
  }

  return workerClient;
}

/** Races a worker call against the worker's own death, so callers can fall back. */
function callCodecWorker<T>(client: RecordingCodecWorkerClient, call: Promise<T>): Promise<T> {
  return Promise.race([call, client.failed]);
}

export { normalizeRecording };

export async function decompressBinaryToRecording(binaryData: Uint8Array): Promise<Recording> {
  // The worker decodes, but the main thread reconstructs frames synchronously
  // during replay (applyContentDelta → diff-match-patch), so the codec must be
  // loaded here regardless of whether the worker is used.
  await loadDmpCodec();
  const client = getRecordingCodecWorkerClient();

  // A dead worker falls back in process rather than stranding the decode — the
  // whole point of keeping the in-process implementation around. The bytes are
  // copied to the worker, not transferred, so that fallback still has them. A
  // decode error is the file's, not the worker's, and is reported as it is.
  const recording = client
    ? await callCodecWorker(client, client.api.decompressBinaryToRecording(binaryData)).catch(
        (error: unknown) => {
          if (error instanceof CodecWorkerFailedError) {
            return decompressBinaryToRecordingInProcess(binaryData);
          }
          throw error;
        },
      )
    : await decompressBinaryToRecordingInProcess(binaryData);
  return hydrateDecodedRecordingWorkspaceAssets(recording);
}

export async function encodeRecordingToStream(recording: Recording): Promise<Uint8Array> {
  const client = getRecordingCodecWorkerClient();

  if (!client || recording.workspaceAssets?.length || typeof indexedDB === "undefined") {
    return encodeRecordingToStreamInProcess(recording);
  }

  return callCodecWorker(client, client.api.encodeRecordingToStream(recording)).catch(() =>
    encodeRecordingToStreamInProcess(recording),
  );
}
