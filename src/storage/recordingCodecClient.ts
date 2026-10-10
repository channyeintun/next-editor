import { loadDmpCodec } from "../core/dmp/dmpCodec";
import type { Recording } from "../core/src";
import { markFramesNormalized } from "../core/src/utils/editorState";
import { spawnComlinkWorkerClient, type ComlinkWorkerClient } from "./comlinkWorkerClient";
import {
  decompressBinaryToRecording as decompressBinaryToRecordingInProcess,
  encodeRecordingToStream as encodeRecordingToStreamInProcess,
  normalizeRecording,
} from "./recordingCodec";
import type { RecordingCodecWorkerApi } from "./recordingCodec.worker";
import { hydrateDecodedRecordingWorkspaceAssets } from "./recordingWorkspaceAssets";
import { isUnreadableRecordingError, type DecodedRecording } from "./streamingRecordingCodec";

/** The codec worker itself died, so the call it was running can be retried in process. */
class CodecWorkerFailedError extends Error {}

let workerClient: ComlinkWorkerClient<RecordingCodecWorkerApi> | null = null;
let workerUnavailable = false;

function canUseRecordingCodecWorker(): boolean {
  return !workerUnavailable && typeof window !== "undefined" && typeof Worker !== "undefined";
}

/**
 * The codec worker, whose calls reject on its death so this module can fall
 * back in process: a hang could never reach the working fallback one branch away.
 */
function getRecordingCodecWorkerClient(): ComlinkWorkerClient<RecordingCodecWorkerApi> | null {
  if (!canUseRecordingCodecWorker()) {
    return null;
  }

  workerClient ??= spawnComlinkWorkerClient<RecordingCodecWorkerApi>({
    spawn: () =>
      new Worker(new URL("./recordingCodec.worker.ts", import.meta.url), {
        name: "next-editor-recording-codec",
        type: "module",
      }),
    failure: () => new CodecWorkerFailedError("Recording codec worker failed"),
    onFailure: () => {
      workerUnavailable = true;
      workerClient = null;
    },
  });

  return workerClient;
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
    ? await client
        .call(client.api.decompressBinaryToRecording(binaryData))
        .catch((error: unknown) => {
          if (error instanceof CodecWorkerFailedError) {
            return decompressBinaryToRecordingInProcess(binaryData);
          }
          throw error;
        })
    : await decompressBinaryToRecordingInProcess(binaryData);
  // The decoder normalized every frame; a worker's mark of that stays in the worker.
  markFramesNormalized(recording.frames);
  return hydrateDecodedRecordingWorkspaceAssets(recording);
}

export async function encodeRecordingToStream(recording: DecodedRecording): Promise<Uint8Array> {
  const client = getRecordingCodecWorkerClient();

  if (!client || recording.workspaceAssets?.length || typeof indexedDB === "undefined") {
    return encodeRecordingToStreamInProcess(recording);
  }

  // The in-process retry serves a worker that died and a worker that cannot read an
  // asset only this thread holds. A refusal to save a too-large take is the
  // recording's own and would fail again, after seconds of main-thread encoding.
  return client.call(client.api.encodeRecordingToStream(recording)).catch((error: unknown) => {
    if (isUnreadableRecordingError(error)) throw error;
    return encodeRecordingToStreamInProcess(recording);
  });
}
