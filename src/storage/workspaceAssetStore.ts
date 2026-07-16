import { base64ToBytes, bytesToBase64, type WorkspaceProject } from "../types/workspace";
import { requestToPromise, toArrayBuffer, transactionToPromise } from "./idb";

/**
 * IndexedDB-backed store for binary workspace asset bytes (images, video, audio,
 * fonts, …). The size-limited localStorage snapshot keeps only the lightweight
 * file metadata with these bytes stripped out; the actual bytes live here, where
 * there is no ~5 MB quota and binary can be stored natively as ArrayBuffers.
 *
 * Assets are keyed by save generation + workspace path. Keeping generations
 * separate lets localStorage publish a new metadata manifest only after every
 * corresponding asset has committed, without overwriting the previous save.
 */

const ASSET_DATABASE_NAME = "next-editor-workspace-assets-db";
const ASSET_DATABASE_VERSION = 1;
const ASSET_STORE = "assets";
const GENERATED_ASSET_KEY_PREFIX = "generation:";

export class WorkspaceAssetPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceAssetPersistenceError";
  }
}

export function createWorkspaceAssetGeneration(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getGeneratedAssetKey(generation: string, path: string): string {
  return `${GENERATED_ASSET_KEY_PREFIX}${encodeURIComponent(generation)}:${path}`;
}

function isGeneratedAssetKeyForGeneration(key: string, generation: string): boolean {
  return key.startsWith(`${GENERATED_ASSET_KEY_PREFIX}${encodeURIComponent(generation)}:`);
}

function getIndexedDB(): IDBFactory | null {
  if (typeof indexedDB === "undefined") {
    return null;
  }

  return indexedDB;
}

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(ASSET_DATABASE_NAME, ASSET_DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(ASSET_STORE)) {
        // Out-of-line keys: the workspace path is supplied per put/get.
        database.createObjectStore(ASSET_STORE);
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

  if (!factory) {
    return null;
  }

  if (!databasePromise) {
    databasePromise = openDatabase(factory);
  }

  return databasePromise;
}

export function collectBinaryAssetPaths(project: WorkspaceProject): string[] {
  return Object.values(project.files)
    .filter((file) => file.encoding === "base64")
    .map((file) => file.path);
}

// Serialize writes so overlapping save generations cannot interleave transactions.
let persistQueue: Promise<void> = Promise.resolve();

export interface PersistWorkspaceAssetsOptions {
  generation: string;
  /** Previous durable generation used to carry assets that are still hydrating. */
  sourceGeneration?: string;
  /** Empty-content paths known to be hydration placeholders rather than empty files. */
  sourceAssetPaths?: ReadonlySet<string>;
}

/**
 * Persist one complete binary-asset generation. The returned promise rejects on
 * unavailable storage or transaction failure so callers cannot mark the project
 * saved until the bytes are actually durable.
 */
export function persistWorkspaceAssets(
  project: WorkspaceProject,
  options: PersistWorkspaceAssetsOptions,
): Promise<void> {
  const run = async () => {
    try {
      await persistWorkspaceAssetsInternal(project, options);
    } catch (error) {
      if (error instanceof WorkspaceAssetPersistenceError) {
        throw error;
      }
      throw new WorkspaceAssetPersistenceError("Failed to persist workspace assets", {
        cause: error,
      });
    }
  };
  const result = persistQueue.then(run, run);
  persistQueue = result.catch(() => undefined);
  return result;
}

async function persistWorkspaceAssetsInternal(
  project: WorkspaceProject,
  { generation, sourceGeneration, sourceAssetPaths }: PersistWorkspaceAssetsOptions,
): Promise<void> {
  const binaryFiles = Object.values(project.files).filter((file) => file.encoding === "base64");

  if (binaryFiles.length === 0) {
    return;
  }

  const databaseResult = getDatabase();

  if (!databaseResult) {
    throw new WorkspaceAssetPersistenceError(
      "This browser does not provide IndexedDB for binary workspace assets",
    );
  }

  const database = await databaseResult;
  const shouldCopyFromSource = (file: (typeof binaryFiles)[number]) =>
    file.content === "" && sourceAssetPaths?.has(file.path) === true;
  const inMemoryEntries = binaryFiles
    .filter((file) => !shouldCopyFromSource(file))
    .map((file) => [file.path, toArrayBuffer(base64ToBytes(file.content))] as const);
  const filesToCopy = binaryFiles.filter(shouldCopyFromSource);
  let copiedEntries: ReadonlyArray<readonly [string, ArrayBuffer]> = [];

  if (filesToCopy.length > 0) {
    const readTransaction = database.transaction(ASSET_STORE, "readonly");
    const readComplete = transactionToPromise(readTransaction);
    const readStore = readTransaction.objectStore(ASSET_STORE);
    const pendingCopies = filesToCopy.map((file) => {
      const sourceKey = sourceGeneration
        ? getGeneratedAssetKey(sourceGeneration, file.path)
        : file.path;
      return [file.path, requestToPromise(readStore.get(sourceKey))] as const;
    });

    const [entries] = await Promise.all([
      Promise.all(
        pendingCopies.map(async ([path, pendingValue]) => {
          const value = await pendingValue;
          if (value instanceof ArrayBuffer) {
            return [path, value] as const;
          }
          if (value instanceof Uint8Array) {
            return [path, toArrayBuffer(value)] as const;
          }
          throw new WorkspaceAssetPersistenceError(
            `Binary workspace asset "${path}" is not available to save`,
          );
        }),
      ),
      readComplete,
    ]);
    copiedEntries = entries;
  }

  const writeTransaction = database.transaction(ASSET_STORE, "readwrite");
  const writeComplete = transactionToPromise(writeTransaction);
  const writeStore = writeTransaction.objectStore(ASSET_STORE);

  for (const [path, buffer] of [...inMemoryEntries, ...copiedEntries]) {
    writeStore.put(buffer, getGeneratedAssetKey(generation, path));
  }

  await writeComplete;
}

/** Best-effort cleanup after a new metadata manifest has been published. */
export function pruneWorkspaceAssetGenerations(currentGeneration: string): Promise<void> {
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
      (key) =>
        typeof key === "string" &&
        (key.startsWith(GENERATED_ASSET_KEY_PREFIX)
          ? !isGeneratedAssetKeyForGeneration(key, currentGeneration)
          : true),
    );

    if (keysToDelete.length === 0) {
      return;
    }

    const writeTransaction = database.transaction(ASSET_STORE, "readwrite");
    const writeComplete = transactionToPromise(writeTransaction);
    const writeStore = writeTransaction.objectStore(ASSET_STORE);
    for (const key of keysToDelete) {
      writeStore.delete(key);
    }

    await writeComplete;
  };

  const result = persistQueue.then(run, run);
  persistQueue = result.catch(() => undefined);
  return result;
}

/**
 * Read stored bytes for the project's binary files and return them as base64,
 * keyed by path, so they can be hydrated back into the in-memory workspace.
 */
export async function loadWorkspaceAssetContents(
  project: WorkspaceProject,
  generation?: string,
): Promise<Record<string, string>> {
  const paths = collectBinaryAssetPaths(project);

  if (paths.length === 0) {
    return {};
  }

  const databaseResult = getDatabase();

  if (!databaseResult) {
    throw new WorkspaceAssetPersistenceError(
      "This browser cannot load the saved binary workspace assets because IndexedDB is unavailable",
    );
  }

  const database = await databaseResult;
  const transaction = database.transaction(ASSET_STORE, "readonly");
  const transactionComplete = transactionToPromise(transaction);
  const store = transaction.objectStore(ASSET_STORE);

  // Issue all reads before awaiting so the transaction stays active.
  const pendingReads = paths.map(
    (path) =>
      [path, store.get(generation ? getGeneratedAssetKey(generation, path) : path)] as const,
  );
  const contents: Record<string, string> = {};
  const foundPaths = new Set<string>();

  await Promise.all([
    Promise.all(
      pendingReads.map(async ([path, request]) => {
        const value = await requestToPromise(request);

        if (value instanceof ArrayBuffer) {
          contents[path] = bytesToBase64(new Uint8Array(value));
          foundPaths.add(path);
        } else if (value instanceof Uint8Array) {
          contents[path] = bytesToBase64(value);
          foundPaths.add(path);
        }
      }),
    ),
    transactionComplete,
  ]);

  if (foundPaths.size !== paths.length) {
    const missingPaths = paths.filter((path) => !foundPaths.has(path));
    throw new WorkspaceAssetPersistenceError(
      `Saved binary workspace assets are missing: ${missingPaths.join(", ")}`,
    );
  }

  return contents;
}
