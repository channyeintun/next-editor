import {
  base64ToBytes,
  getWorkspaceFileMimeType,
  isLegacyWorkspaceBinaryFile,
  isWorkspaceAssetFile,
  type WorkspaceAssetDescriptor,
  type WorkspaceProject,
} from "../types/workspace";
import { requestToPromise, toArrayBuffer, transactionToPromise } from "./idb";

/**
 * Binary workspace assets live outside the project graph. The graph carries a
 * small content-addressed descriptor; this store keeps the Blob once and only
 * materializes Uint8Array at an explicit filesystem/upload/export boundary.
 *
 * Database v1 stored generation/path keyed ArrayBuffers for base64 workspace
 * files. V2 keeps those entries readable for migration and writes new assets by
 * SHA-256 id under `asset:<id>`.
 */

const ASSET_DATABASE_NAME = "next-editor-workspace-assets-db";
const ASSET_DATABASE_VERSION = 2;
const ASSET_STORE = "assets";
const ASSET_KEY_PREFIX = "asset:";
const GENERATED_ASSET_KEY_PREFIX = "generation:";

export class WorkspaceAssetPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceAssetPersistenceError";
  }
}

function getGeneratedAssetKey(generation: string, path: string): string {
  return `${GENERATED_ASSET_KEY_PREFIX}${encodeURIComponent(generation)}:${path}`;
}

function getAssetKey(assetId: string): string {
  return `${ASSET_KEY_PREFIX}${assetId}`;
}

function getIndexedDB(): IDBFactory | null {
  return typeof indexedDB === "undefined" ? null : indexedDB;
}

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(ASSET_DATABASE_NAME, ASSET_DATABASE_VERSION);

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(ASSET_STORE)) {
        request.result.createObjectStore(ASSET_STORE);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error("Failed to open workspace asset database"));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error("Workspace asset database upgrade is blocked"));
    };
  });
}

function getDatabase(): Promise<IDBDatabase> | null {
  const factory = getIndexedDB();
  if (!factory) return null;
  databasePromise ??= openDatabase(factory);
  return databasePromise;
}

const blobCache = new Map<string, Blob>();
const assetListeners = new Set<(assetId: string) => void>();
let assetWriteQueue: Promise<void> = Promise.resolve();

function notifyAssetAvailable(assetId: string): void {
  for (const listener of assetListeners) listener(assetId);
}

export function subscribeWorkspaceAssetAvailability(
  listener: (assetId: string) => void,
): () => void {
  assetListeners.add(listener);
  return () => assetListeners.delete(listener);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new WorkspaceAssetPersistenceError(
      "This browser cannot create content-addressed workspace assets",
    );
  }
  const digest = await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function asBlob(value: unknown, mimeType: string): Blob | null {
  if (value instanceof Blob) {
    return value.type === mimeType ? value : value.slice(0, value.size, mimeType);
  }
  if (value instanceof ArrayBuffer) return new Blob([value], { type: mimeType });
  if (value instanceof Uint8Array) {
    return new Blob([toArrayBuffer(value)], { type: mimeType });
  }
  return null;
}

async function writeAssetBlob(assetId: string, blob: Blob): Promise<boolean> {
  const databaseResult = getDatabase();
  if (!databaseResult) return false;

  const run = async () => {
    const database = await databaseResult;
    const transaction = database.transaction(ASSET_STORE, "readwrite");
    const complete = transactionToPromise(transaction);
    transaction.objectStore(ASSET_STORE).put(blob, getAssetKey(assetId));
    await complete;
  };
  const result = assetWriteQueue.then(run, run);
  assetWriteQueue = result.catch(() => undefined);
  await result;
  return true;
}

export interface RegisterWorkspaceAssetOptions {
  mimeType: string;
  /** Collaboration downloads already carry their authoritative SHA-256 id. */
  expectedAssetId?: string;
}

export async function registerWorkspaceAsset(
  bytes: Uint8Array,
  options: RegisterWorkspaceAssetOptions,
): Promise<WorkspaceAssetDescriptor> {
  const assetId = await sha256Hex(bytes);
  if (options.expectedAssetId && options.expectedAssetId !== assetId) {
    throw new WorkspaceAssetPersistenceError(
      "The workspace asset failed its content-integrity check",
    );
  }

  const mimeType = options.mimeType || "application/octet-stream";
  const descriptor: WorkspaceAssetDescriptor = {
    kind: "asset",
    assetId,
    mimeType,
    size: bytes.byteLength,
  };
  const cached = blobCache.get(assetId);
  const blob = cached ?? new Blob([exactArrayBuffer(bytes)], { type: mimeType });
  blobCache.set(assetId, blob);
  await writeAssetBlob(assetId, blob);
  notifyAssetAvailable(assetId);
  return descriptor;
}

export async function getWorkspaceAssetBlob(
  descriptor: WorkspaceAssetDescriptor,
): Promise<Blob> {
  const cached = blobCache.get(descriptor.assetId);
  if (cached) {
    if (cached.size !== descriptor.size) {
      throw new WorkspaceAssetPersistenceError("Cached workspace asset size does not match");
    }
    return cached.type === descriptor.mimeType
      ? cached
      : cached.slice(0, cached.size, descriptor.mimeType);
  }

  const databaseResult = getDatabase();
  if (!databaseResult) {
    throw new WorkspaceAssetPersistenceError("Workspace asset storage is unavailable");
  }
  const database = await databaseResult;
  const transaction = database.transaction(ASSET_STORE, "readonly");
  const complete = transactionToPromise(transaction);
  const [value] = await Promise.all([
    requestToPromise(transaction.objectStore(ASSET_STORE).get(getAssetKey(descriptor.assetId))),
    complete,
  ]);
  const blob = asBlob(value, descriptor.mimeType);
  if (!blob || blob.size !== descriptor.size) {
    throw new WorkspaceAssetPersistenceError(
      `Workspace asset ${descriptor.assetId} is missing or corrupt`,
    );
  }
  blobCache.set(descriptor.assetId, blob);
  return blob;
}

export async function getWorkspaceAssetBytes(
  descriptor: WorkspaceAssetDescriptor,
): Promise<Uint8Array> {
  return new Uint8Array(await (await getWorkspaceAssetBlob(descriptor)).arrayBuffer());
}

export function collectBinaryAssetPaths(project: WorkspaceProject): string[] {
  return Object.values(project.files)
    .filter((file) => isWorkspaceAssetFile(file) || isLegacyWorkspaceBinaryFile(file))
    .map((file) => file.path);
}

/**
 * Convert v1 generation/path assets (and older inline base64 projects) to v2
 * descriptors. This is the sole remaining base64 decode boundary.
 */
export async function migrateLegacyWorkspaceAssets(
  project: WorkspaceProject,
  generation?: string,
): Promise<Record<string, WorkspaceAssetDescriptor>> {
  const legacyFiles = Object.values(project.files).filter(isLegacyWorkspaceBinaryFile);
  if (legacyFiles.length === 0) return {};

  const pendingBytes = new Map<string, Uint8Array>();
  for (const file of legacyFiles) {
    if (file.content) pendingBytes.set(file.path, base64ToBytes(file.content));
  }

  const storedFiles = legacyFiles.filter((file) => !pendingBytes.has(file.path));
  if (storedFiles.length > 0) {
    const databaseResult = getDatabase();
    if (!databaseResult) {
      throw new WorkspaceAssetPersistenceError(
        "This browser cannot load legacy workspace assets because IndexedDB is unavailable",
      );
    }
    const database = await databaseResult;
    const transaction = database.transaction(ASSET_STORE, "readonly");
    const complete = transactionToPromise(transaction);
    const reads = storedFiles.map((file) => {
      const key = generation ? getGeneratedAssetKey(generation, file.path) : file.path;
      return [file, requestToPromise(transaction.objectStore(ASSET_STORE).get(key))] as const;
    });
    await Promise.all([
      Promise.all(
        reads.map(async ([file, request]) => {
          const blob = asBlob(await request, getWorkspaceFileMimeType(file.path));
          if (!blob) {
            throw new WorkspaceAssetPersistenceError(
              `Saved binary workspace asset "${file.path}" is missing`,
            );
          }
          pendingBytes.set(file.path, new Uint8Array(await blob.arrayBuffer()));
        }),
      ),
      complete,
    ]);
  }

  const descriptors: Record<string, WorkspaceAssetDescriptor> = {};
  for (const file of legacyFiles) {
    const bytes = pendingBytes.get(file.path);
    if (!bytes) continue;
    descriptors[file.path] = await registerWorkspaceAsset(bytes, {
      mimeType: getWorkspaceFileMimeType(file.path),
    });
  }
  return descriptors;
}

/** Verify that every descriptor referenced by the save has durable bytes. */
export async function persistWorkspaceAssets(project: WorkspaceProject): Promise<void> {
  try {
    const assetFiles = Object.values(project.files).filter(isWorkspaceAssetFile);
    if (assetFiles.length === 0) return;
    if (!getDatabase()) {
      throw new WorkspaceAssetPersistenceError(
        "This browser does not provide IndexedDB for binary workspace assets",
      );
    }

    for (const file of assetFiles) {
      const blob = await getWorkspaceAssetBlob(file.content);
      await writeAssetBlob(file.content.assetId, blob);
    }
  } catch (error) {
    if (error instanceof WorkspaceAssetPersistenceError) throw error;
    throw new WorkspaceAssetPersistenceError("Failed to persist workspace assets", {
      cause: error,
    });
  }
}

/** Best-effort cleanup after a project manifest has been published. */
export function pruneWorkspaceAssets(project: WorkspaceProject): Promise<void> {
  const run = async () => {
    void project;
    const databaseResult = getDatabase();
    if (!databaseResult) return;
    const database = await databaseResult;
    const readTransaction = database.transaction(ASSET_STORE, "readonly");
    const readComplete = transactionToPromise(readTransaction);
    const [keys] = await Promise.all([
      requestToPromise(readTransaction.objectStore(ASSET_STORE).getAllKeys()),
      readComplete,
    ]);
    const keysToDelete = keys.filter(
      (key) => typeof key === "string" && !key.startsWith(ASSET_KEY_PREFIX),
    );
    if (keysToDelete.length === 0) return;
    const transaction = database.transaction(ASSET_STORE, "readwrite");
    const complete = transactionToPromise(transaction);
    const store = transaction.objectStore(ASSET_STORE);
    for (const key of keysToDelete) store.delete(key);
    await complete;
  };
  const result = assetWriteQueue.then(run, run);
  assetWriteQueue = result.catch(() => undefined);
  return result;
}

/** Reset cached IDB and Blob state between isolated unit-test factories. */
export function resetWorkspaceAssetStoreForTests(): void {
  const pendingDatabase = databasePromise;
  databasePromise = null;
  assetWriteQueue = Promise.resolve();
  blobCache.clear();
  assetListeners.clear();
  void pendingDatabase?.then((database) => database.close()).catch(() => undefined);
}
