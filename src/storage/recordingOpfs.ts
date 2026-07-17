import { transfer, wrap, type Remote } from "comlink";
import type { RecordingOpfsWorkerApi } from "./recordingOpfs.worker";
import { RECORDING_OPFS_DIRECTORY, recordingOpfsFilename } from "./recordingOpfsShared";

interface StorageManagerWithOpfs {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
}

interface RecordingOpfsClient {
  api: Remote<RecordingOpfsWorkerApi>;
  worker: Worker;
}

let client: RecordingOpfsClient | null = null;
let unavailable = false;
let availabilityPromise: Promise<boolean> | null = null;

function canUseOpfsWorker(): boolean {
  const storage = globalThis.navigator?.storage as unknown as StorageManagerWithOpfs | undefined;
  return (
    !unavailable &&
    typeof window !== "undefined" &&
    typeof Worker !== "undefined" &&
    typeof storage?.getDirectory === "function"
  );
}

function getClient(): RecordingOpfsClient | null {
  if (!canUseOpfsWorker()) return null;
  if (client) return client;

  try {
    const worker = new Worker(new URL("./recordingOpfs.worker.ts", import.meta.url), {
      name: "next-editor-recording-opfs",
      type: "module",
    });
    client = { api: wrap<RecordingOpfsWorkerApi>(worker), worker };
    return client;
  } catch {
    unavailable = true;
    return null;
  }
}

function transferableCopy(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  return transfer(copy, [copy.buffer as ArrayBuffer]);
}

export function isRecordingOpfsAvailable(): Promise<boolean> {
  if (!availabilityPromise) {
    const current = getClient();
    availabilityPromise = current
      ? current.api.isAvailable().catch(() => {
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
  return current.api.replace(recordingId, transferableCopy(bytes));
}

export async function appendRecordingOpfs(
  recordingId: string,
  bytes: Uint8Array,
  expectedOffset: number,
): Promise<number> {
  const current = getClient();
  if (!current || !(await isRecordingOpfsAvailable())) {
    throw new Error("Origin-private recording storage is unavailable");
  }
  return current.api.append(recordingId, transferableCopy(bytes), expectedOffset);
}

export async function openRecordingOpfsStream(
  recordingId: string,
): Promise<ReadableStream<Uint8Array> | null> {
  if (!(await isRecordingOpfsAvailable())) return null;
  const storage = navigator.storage as unknown as StorageManagerWithOpfs;
  try {
    const root = await storage.getDirectory!();
    const directory = await root.getDirectoryHandle(RECORDING_OPFS_DIRECTORY);
    const handle = await directory.getFileHandle(recordingOpfsFilename(recordingId));
    return (await handle.getFile()).stream();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
}

export async function deleteRecordingOpfs(recordingId: string): Promise<void> {
  const current = getClient();
  if (!current || !(await isRecordingOpfsAvailable())) return;
  await current.api.delete(recordingId);
}

export async function clearRecordingOpfs(): Promise<void> {
  const current = getClient();
  if (!current || !(await isRecordingOpfsAvailable())) return;
  await current.api.clear();
}
