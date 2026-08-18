import { transfer, wrap, type Remote } from "comlink";
import type { RecordingOpfsWorkerApi } from "./recordingOpfs.worker";
import { RECORDING_OPFS_DIRECTORY, recordingOpfsFilename } from "./recordingOpfsShared";

interface StorageManagerWithOpfs {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
}

interface RecordingOpfsClient {
  api: Remote<RecordingOpfsWorkerApi>;
  worker: Worker;
  /**
   * Rejects when the worker dies. Comlink settles a call only when a reply
   * message arrives, so without something to race against, a worker that fails
   * at runtime leaves every call pending forever — and a pending
   * `appendSegments` is never removed from the store's append queue, wedging
   * save, delete and clear for the rest of the page's life.
   */
  failed: Promise<never>;
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

    // The constructor only throws for a synchronously rejected worker. One whose
    // module fails at runtime — chunk fetched over a flaky network, or the worker
    // killed under memory pressure mid-save — constructs fine and then fires
    // `error`, which nothing used to listen for.
    let failWorker: (error: Error) => void = () => {};
    const failed = new Promise<never>((_, reject) => {
      failWorker = reject;
    });
    failed.catch(() => {});
    const onWorkerFailure = () => {
      unavailable = true;
      availabilityPromise = null;
      client = null;
      worker.terminate();
      failWorker(new Error("Origin-private recording storage worker failed"));
    };
    worker.addEventListener("error", onWorkerFailure);
    worker.addEventListener("messageerror", onWorkerFailure);

    client = { api: wrap<RecordingOpfsWorkerApi>(worker), worker, failed };
    return client;
  } catch {
    unavailable = true;
    return null;
  }
}

/**
 * Every worker call races the worker's own death, so callers get a rejection
 * they can fall back from instead of a promise that never settles.
 */
function callWorker<T>(current: RecordingOpfsClient, call: Promise<T>): Promise<T> {
  return Promise.race([call, current.failed]);
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
          callWorker(current, current.api.isAvailable()),
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
  return callWorker(current, current.api.replace(recordingId, transferableCopy(bytes)));
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
  return callWorker(
    current,
    current.api.append(recordingId, transferableCopy(bytes), expectedOffset),
  );
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
  await callWorker(current, current.api.delete(recordingId));
}

export async function clearRecordingOpfs(): Promise<void> {
  const current = getClient();
  if (!current || !(await isRecordingOpfsAvailable())) return;
  await callWorker(current, current.api.clear());
}
