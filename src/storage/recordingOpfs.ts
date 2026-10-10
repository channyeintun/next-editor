import { transfer } from "comlink";
import { spawnComlinkWorkerClient, type ComlinkWorkerClient } from "./comlinkWorkerClient";
import type { RecordingOpfsWorkerApi } from "./recordingOpfs.worker";
import {
  isNotFoundError,
  RECORDING_OPFS_DIRECTORY,
  recordingOpfsFilename,
} from "./recordingOpfsShared";

let client: ComlinkWorkerClient<RecordingOpfsWorkerApi> | null = null;
let unavailable = false;
let availabilityPromise: Promise<boolean> | null = null;

/** The storage manager when this browser has OPFS, or null (older browsers, jsdom). */
function getOpfsStorage(): StorageManager | null {
  const storage: StorageManager | undefined = globalThis.navigator?.storage;
  return typeof storage?.getDirectory === "function" ? storage : null;
}

function canUseOpfsWorker(): boolean {
  return (
    !unavailable &&
    typeof window !== "undefined" &&
    typeof Worker !== "undefined" &&
    getOpfsStorage() !== null
  );
}

/**
 * The writer worker. Its calls reject when it dies, so a save or delete waiting
 * on one can fall back instead of waiting forever.
 */
function getClient(): ComlinkWorkerClient<RecordingOpfsWorkerApi> | null {
  if (!canUseOpfsWorker()) return null;

  client ??= spawnComlinkWorkerClient<RecordingOpfsWorkerApi>({
    spawn: () =>
      new Worker(new URL("./recordingOpfs.worker.ts", import.meta.url), {
        name: "next-editor-recording-opfs",
        type: "module",
      }),
    failure: () => new Error("Origin-private recording storage worker failed"),
    onFailure: () => {
      unavailable = true;
      availabilityPromise = null;
      client = null;
    },
  });
  return client;
}

// Backstop for a worker that neither replies nor reports an error. Only the
// availability probe needs it: it is the gate every other call waits behind.
const AVAILABILITY_TIMEOUT_MS = 10_000;

function transferableCopy(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  return transfer(copy, [copy.buffer as ArrayBuffer]);
}

export function isRecordingOpfsAvailable(): Promise<boolean> {
  if (!availabilityPromise) {
    const current = getClient();
    availabilityPromise = current
      ? Promise.race([
          current.call(current.api.isAvailable()),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), AVAILABILITY_TIMEOUT_MS),
          ),
        ]).catch(() => {
          unavailable = true;
          return false;
        })
      : Promise.resolve(false);
  }
  return availabilityPromise;
}

export async function replaceRecordingOpfs(
  recordingId: string,
  bytes: Uint8Array,
): Promise<number> {
  const current = getClient();
  if (!current || !(await isRecordingOpfsAvailable())) {
    throw new Error("Origin-private recording storage is unavailable");
  }
  return current.call(current.api.replace(recordingId, transferableCopy(bytes)));
}

/**
 * Streams a stored recording, or returns null when its file does not exist.
 * Reading needs no worker, so the writer worker is not consulted: a take stored
 * earlier stays readable when the worker fails to start. Storage that cannot be
 * reached is an error, never passed off as a missing take.
 */
export async function openRecordingOpfsStream(
  recordingId: string,
): Promise<ReadableStream<Uint8Array> | null> {
  const storage = getOpfsStorage();
  if (!storage) {
    throw new Error("Origin-private recording storage is unavailable");
  }
  try {
    const root = await storage.getDirectory();
    const directory = await root.getDirectoryHandle(RECORDING_OPFS_DIRECTORY);
    const handle = await directory.getFileHandle(recordingOpfsFilename(recordingId));
    return (await handle.getFile()).stream();
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export async function deleteRecordingOpfs(recordingId: string): Promise<void> {
  const current = getClient();
  if (current && (await isRecordingOpfsAvailable())) {
    // Through the worker, so the removal waits for any write it has queued for this id.
    await current.call(current.api.delete(recordingId));
    return;
  }
  // Without a writer there is no queued write to wait for, so remove the file here.
  // Without OPFS at all, nothing can have been stored there.
  const storage = getOpfsStorage();
  if (!storage) return;
  try {
    const root = await storage.getDirectory();
    const directory = await root.getDirectoryHandle(RECORDING_OPFS_DIRECTORY);
    await directory.removeEntry(recordingOpfsFilename(recordingId));
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}
