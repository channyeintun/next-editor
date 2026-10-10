import {
  isLegacyWorkspaceBinaryFile,
  isWorkspaceAssetFile,
  type WorkspaceAssetDescriptor,
  type WorkspaceProject,
} from "../types/workspace";
import { getWorkspaceFileMimeType } from "../types/workspaceFiles";
import { base64ToBytes } from "../shared/base64";
import { sha256Hex } from "../shared/sha256Hex";
import { createDatabaseOpener, requestToPromise, toArrayBuffer, transactionToPromise } from "./idb";

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

const databaseOpener = createDatabaseOpener({
  name: ASSET_DATABASE_NAME,
  version: ASSET_DATABASE_VERSION,
  upgrade: (database) => {
    if (!database.objectStoreNames.contains(ASSET_STORE)) {
      database.createObjectStore(ASSET_STORE);
    }
  },
  openError: "Failed to open workspace asset database",
  blockedError: "Workspace asset database upgrade is blocked",
});

function getDatabase(): Promise<IDBDatabase> | null {
  const factory = getIndexedDB();
  return factory ? databaseOpener.open(factory) : null;
}

/**
 * Blobs by asset id: the disk-backed ones IndexedDB reads return, and each
 * registered asset's memory-built Blob until its write commits. Keeping the
 * memory-built ones past that held every asset of every lesson opened in the
 * tab in memory until it closed. Without IndexedDB nothing commits, so there
 * the memory-built Blob, the only copy, stays.
 */
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

async function workspaceAssetId(bytes: ArrayBuffer): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new WorkspaceAssetPersistenceError(
      "This browser cannot create content-addressed workspace assets",
    );
  }
  return sha256Hex(bytes);
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

/**
 * Stores an asset unless IndexedDB already holds a copy of the right size (the
 * repair rule persistWorkspaceAssets uses; reading a stored Blob yields a handle,
 * not its bytes). "written" when it stored the asset, "present" when the stored
 * copy was kept, "unavailable" when there is no IndexedDB to store it in.
 */
async function writeAssetBlob(
  assetId: string,
  blob: Blob,
): Promise<"written" | "present" | "unavailable"> {
  const databaseResult = getDatabase();
  if (!databaseResult) return "unavailable";

  const run = async () => {
    const database = await databaseResult;
    const transaction = database.transaction(ASSET_STORE, "readwrite");
    const complete = transactionToPromise(transaction);
    const store = transaction.objectStore(ASSET_STORE);
    const key = getAssetKey(assetId);
    let outcome: "written" | "present" = "written";
    // The put is issued from the get's success callback, while the transaction is
    // still active; awaiting the get would let it commit first.
    const existing = store.get(key);
    existing.onsuccess = () => {
      if (asBlob(existing.result, blob.type)?.size === blob.size) {
        outcome = "present";
        return;
      }
      store.put(blob, key);
    };
    await complete;
    return outcome;
  };
  const result = assetWriteQueue.then(run, run);
  assetWriteQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Drops a memory-built Blob IndexedDB now holds; the next read gets the stored copy. */
function releaseStoredBlob(assetId: string, blob: Blob): void {
  if (blobCache.get(assetId) === blob) blobCache.delete(assetId);
}

export interface RegisterWorkspaceAssetOptions {
  mimeType: string;
  /** Collaboration downloads already carry their authoritative SHA-256 id. */
  expectedAssetId?: string;
}

/**
 * Stores an asset's bytes under their SHA-256 id and tells availability listeners
 * once it can be read. Re-registering bytes that are already stored (runtime
 * reverse sync does this for every binary file on every container change) neither
 * rewrites them nor notifies again, so open media does not reload.
 */
export async function registerWorkspaceAsset(
  bytes: Uint8Array,
  options: RegisterWorkspaceAssetOptions,
): Promise<WorkspaceAssetDescriptor> {
  // One standalone copy serves both the digest and the Blob. Both take a BufferSource,
  // which excludes views on a SharedArrayBuffer (available here: the app is
  // cross-origin isolated), so neither may be handed the caller's view as is.
  const buffer = toArrayBuffer(bytes);
  const assetId = await workspaceAssetId(buffer);
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
  const blob = cached ?? new Blob([buffer], { type: mimeType });
  // Cached while the write runs, so a read racing it still finds the asset.
  blobCache.set(assetId, blob);
  const outcome = await writeAssetBlob(assetId, blob);
  if (outcome !== "unavailable") releaseStoredBlob(assetId, blob);
  // Without IndexedDB the memory cache is the only copy, so the asset became
  // available only if this call put it there.
  if (outcome === "written" || (outcome === "unavailable" && !cached)) {
    notifyAssetAvailable(assetId);
  }
  return descriptor;
}

export async function getWorkspaceAssetBlob(descriptor: WorkspaceAssetDescriptor): Promise<Blob> {
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

/**
 * Verify that every descriptor referenced by the save has durable bytes.
 *
 * Registering an asset already stores it, so this normally only reads. It writes
 * an asset back from memory when its stored copy is missing or the wrong size and
 * memory still holds it, which it does only until a write commits (a registration
 * whose write failed); an asset that is in neither place fails the save.
 */
export async function persistWorkspaceAssets(project: WorkspaceProject): Promise<void> {
  try {
    const assetFiles = Object.values(project.files).filter(isWorkspaceAssetFile);
    if (assetFiles.length === 0) return;
    const databaseResult = getDatabase();
    if (!databaseResult) {
      throw new WorkspaceAssetPersistenceError(
        "This browser does not provide IndexedDB for binary workspace assets",
      );
    }

    const database = await databaseResult;
    const transaction = database.transaction(ASSET_STORE, "readonly");
    const complete = transactionToPromise(transaction);
    const store = transaction.objectStore(ASSET_STORE);
    // Reading a stored Blob yields a handle; its bytes are not loaded.
    const [storedValues] = await Promise.all([
      Promise.all(
        assetFiles.map((file) => requestToPromise(store.get(getAssetKey(file.content.assetId)))),
      ),
      complete,
    ]);

    for (const [index, file] of assetFiles.entries()) {
      const descriptor = file.content;
      if (asBlob(storedValues[index], descriptor.mimeType)?.size === descriptor.size) continue;
      const cached = blobCache.get(descriptor.assetId);
      if (!cached || cached.size !== descriptor.size) {
        throw new WorkspaceAssetPersistenceError(
          `Workspace asset ${descriptor.assetId} is missing or corrupt`,
        );
      }
      if ((await writeAssetBlob(descriptor.assetId, cached)) !== "unavailable") {
        releaseStoredBlob(descriptor.assetId, cached);
      }
    }
  } catch (error) {
    if (error instanceof WorkspaceAssetPersistenceError) throw error;
    throw new WorkspaceAssetPersistenceError("Failed to persist workspace assets", {
      cause: error,
    });
  }
}

/**
 * Best-effort removal of the v1 generation/path entries once the migrated manifest is
 * durable. Content-addressed `asset:` entries are never pruned here: stored recordings and
 * other sessions may share them, so an asset the project no longer references can still be
 * in use.
 */
export function pruneLegacyWorkspaceAssetKeys(): Promise<void> {
  const run = async () => {
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
  databaseOpener.reset();
  assetWriteQueue = Promise.resolve();
  blobCache.clear();
  assetListeners.clear();
}
