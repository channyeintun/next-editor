import { expose } from "comlink";
import { RECORDING_OPFS_DIRECTORY, recordingOpfsFilename } from "./recordingOpfsShared";

interface StorageManagerWithOpfs {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
}

interface SyncAccessHandleLike {
  close(): void;
  flush(): void;
  truncate(newSize: number): void;
  write(buffer: Uint8Array, options?: { at?: number }): number;
}

interface FileHandleWithSyncAccess {
  createSyncAccessHandle?: () => Promise<SyncAccessHandleLike>;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

async function getRootDirectory(): Promise<FileSystemDirectoryHandle> {
  const storage = navigator.storage as unknown as StorageManagerWithOpfs;
  if (typeof storage?.getDirectory !== "function") {
    throw new Error("Origin-private file storage is unavailable");
  }
  return storage.getDirectory();
}

async function getRecordingDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await getRootDirectory();
  return root.getDirectoryHandle(RECORDING_OPFS_DIRECTORY, { create: true });
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * Replaces the file's contents through a synchronous access handle and returns the
 * number of bytes written, or null when this browser offers no such handle.
 */
async function writeWithSyncHandle(
  fileHandle: FileSystemFileHandle,
  bytes: Uint8Array,
): Promise<number | null> {
  const createSyncAccessHandle = (fileHandle as unknown as FileHandleWithSyncAccess)
    .createSyncAccessHandle;
  if (typeof createSyncAccessHandle !== "function") return null;

  const access = await createSyncAccessHandle.call(fileHandle);
  try {
    access.truncate(0);
    let written = 0;
    while (written < bytes.byteLength) {
      const count = access.write(bytes.subarray(written), { at: written });
      if (count <= 0) throw new Error("OPFS sync write made no progress");
      written += count;
    }
    access.flush();
    return written;
  } finally {
    access.close();
  }
}

async function writeWithAsyncHandle(
  fileHandle: FileSystemFileHandle,
  bytes: Uint8Array,
): Promise<number> {
  const writable = await fileHandle.createWritable();
  // Writes land in a swap file: close() commits it over the old contents, abort()
  // throws it away. A failed write (quota) must abort, or it would replace the file
  // with a truncated one.
  try {
    if (bytes.byteLength > 0) await writable.write(exactArrayBuffer(bytes));
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
  await writable.close();
  return bytes.byteLength;
}

/** Replaces a recording's OPFS file with `bytes`, returning how many bytes it now holds. */
async function writeRecording(recordingId: string, bytes: Uint8Array): Promise<number> {
  const directory = await getRecordingDirectory();
  const fileHandle = await directory.getFileHandle(recordingOpfsFilename(recordingId), {
    create: true,
  });
  const syncSize = await writeWithSyncHandle(fileHandle, bytes);
  if (syncSize !== null) return syncSize;
  return writeWithAsyncHandle(fileHandle, bytes);
}

const writeQueues = new Map<string, Promise<unknown>>();

function enqueueWrite<T>(recordingId: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(recordingId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  writeQueues.set(recordingId, next);
  return next.finally(() => {
    if (writeQueues.get(recordingId) === next) writeQueues.delete(recordingId);
  });
}

const api = {
  async isAvailable(): Promise<boolean> {
    try {
      await getRecordingDirectory();
      return true;
    } catch {
      return false;
    }
  },
  replace(recordingId: string, bytes: Uint8Array): Promise<number> {
    return enqueueWrite(recordingId, () => writeRecording(recordingId, bytes));
  },
  async delete(recordingId: string): Promise<void> {
    await (writeQueues.get(recordingId) ?? Promise.resolve()).catch(() => {});
    const directory = await getRecordingDirectory();
    try {
      await directory.removeEntry(recordingOpfsFilename(recordingId));
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  },
};

export type RecordingOpfsWorkerApi = typeof api;

expose(api);
