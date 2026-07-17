import { expose } from "comlink";
import { RECORDING_OPFS_DIRECTORY, recordingOpfsFilename } from "./recordingOpfsShared";

interface StorageManagerWithOpfs {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
}

interface SyncAccessHandleLike {
  close(): void;
  flush(): void;
  getSize(): number;
  read(buffer: Uint8Array, options?: { at?: number }): number;
  truncate(newSize: number): void;
  write(buffer: Uint8Array, options?: { at?: number }): number;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function syncTailMatches(
  access: SyncAccessHandleLike,
  expectedOffset: number,
  bytes: Uint8Array,
): boolean {
  if (bytes.byteLength === 0) return true;
  const existing = new Uint8Array(bytes.byteLength);
  let readOffset = 0;
  while (readOffset < existing.byteLength) {
    const read = access.read(existing.subarray(readOffset), { at: expectedOffset + readOffset });
    if (read <= 0) return false;
    readOffset += read;
  }
  return bytesEqual(existing, bytes);
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

async function writeWithSyncHandle(
  fileHandle: FileSystemFileHandle,
  bytes: Uint8Array,
  append: boolean,
  expectedOffset?: number,
): Promise<number | null> {
  const createSyncAccessHandle = (fileHandle as unknown as FileHandleWithSyncAccess)
    .createSyncAccessHandle;
  if (typeof createSyncAccessHandle !== "function") return null;

  const access = await createSyncAccessHandle.call(fileHandle);
  try {
    const currentSize = append ? access.getSize() : 0;
    if (append && expectedOffset !== undefined) {
      if (
        currentSize === expectedOffset + bytes.byteLength &&
        syncTailMatches(access, expectedOffset, bytes)
      ) {
        return currentSize;
      }
      if (currentSize !== expectedOffset) {
        throw new Error(
          `OPFS append offset mismatch: expected ${expectedOffset}, received ${currentSize}`,
        );
      }
    }
    let fileOffset = currentSize;
    if (!append) access.truncate(0);

    let inputOffset = 0;
    while (inputOffset < bytes.byteLength) {
      const written = access.write(bytes.subarray(inputOffset), { at: fileOffset });
      if (written <= 0) throw new Error("OPFS sync write made no progress");
      inputOffset += written;
      fileOffset += written;
    }
    access.flush();
    return fileOffset;
  } finally {
    access.close();
  }
}

async function writeWithAsyncHandle(
  fileHandle: FileSystemFileHandle,
  bytes: Uint8Array,
  append: boolean,
  expectedOffset?: number,
): Promise<number> {
  const existingFile = append ? await fileHandle.getFile() : null;
  const existingSize = existingFile?.size ?? 0;
  if (append && expectedOffset !== undefined) {
    if (existingSize === expectedOffset + bytes.byteLength) {
      const existing = new Uint8Array(
        await existingFile!.slice(expectedOffset, existingSize).arrayBuffer(),
      );
      if (bytesEqual(existing, bytes)) return existingSize;
    }
    if (existingSize !== expectedOffset) {
      throw new Error(
        `OPFS append offset mismatch: expected ${expectedOffset}, received ${existingSize}`,
      );
    }
  }
  const writable = await fileHandle.createWritable({ keepExistingData: append });
  try {
    if (append) await writable.seek(existingSize);
    if (bytes.byteLength > 0) await writable.write(exactArrayBuffer(bytes));
  } finally {
    await writable.close();
  }
  return existingSize + bytes.byteLength;
}

async function writeRecording(
  recordingId: string,
  bytes: Uint8Array,
  append: boolean,
  expectedOffset?: number,
): Promise<number> {
  const directory = await getRecordingDirectory();
  const fileHandle = await directory.getFileHandle(recordingOpfsFilename(recordingId), {
    create: true,
  });
  const syncSize = await writeWithSyncHandle(fileHandle, bytes, append, expectedOffset);
  if (syncSize !== null) return syncSize;
  return writeWithAsyncHandle(fileHandle, bytes, append, expectedOffset);
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
    return enqueueWrite(recordingId, () => writeRecording(recordingId, bytes, false));
  },
  append(recordingId: string, bytes: Uint8Array, expectedOffset: number): Promise<number> {
    return enqueueWrite(recordingId, () =>
      writeRecording(recordingId, bytes, true, expectedOffset),
    );
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
  async clear(): Promise<void> {
    await Promise.all(Array.from(writeQueues.values(), (pending) => pending.catch(() => {})));
    const root = await getRootDirectory();
    try {
      await root.removeEntry(RECORDING_OPFS_DIRECTORY, { recursive: true });
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  },
};

export type RecordingOpfsWorkerApi = typeof api;

expose(api);
