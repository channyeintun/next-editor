import { base64ToBytes, bytesToBase64, type WorkspaceProject } from "../types/workspace";
import { requestToPromise, toArrayBuffer, transactionToPromise } from "./idb";

/**
 * IndexedDB-backed store for binary workspace asset bytes (images, video, audio,
 * fonts, …). The size-limited localStorage snapshot keeps only the lightweight
 * file metadata with these bytes stripped out; the actual bytes live here, where
 * there is no ~5 MB quota and binary can be stored natively as ArrayBuffers.
 *
 * Assets are keyed by their workspace path.
 */

const ASSET_DATABASE_NAME = "next-editor-workspace-assets-db";
const ASSET_DATABASE_VERSION = 1;
const ASSET_STORE = "assets";

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

// Serialize writes so overlapping saves can't race on the prune/put cycle.
let persistQueue: Promise<void> = Promise.resolve();

/**
 * Persist the project's binary asset bytes, pruning any stored assets that no
 * longer exist. Assets whose in-memory content is still empty (e.g. not yet
 * hydrated from a previous session) are kept but not overwritten, so a save
 * before hydration completes never wipes their bytes.
 */
export function persistWorkspaceAssets(project: WorkspaceProject): Promise<void> {
  const run = () => persistWorkspaceAssetsInternal(project);
  persistQueue = persistQueue.then(run, run);
  return persistQueue;
}

async function persistWorkspaceAssetsInternal(project: WorkspaceProject): Promise<void> {
  const databaseResult = getDatabase();

  if (!databaseResult) {
    return;
  }

  const keepPaths = new Set<string>();
  const entries: Array<[string, ArrayBuffer]> = [];

  for (const file of Object.values(project.files)) {
    if (file.encoding !== "base64") {
      continue;
    }

    keepPaths.add(file.path);

    if (file.content) {
      entries.push([file.path, toArrayBuffer(base64ToBytes(file.content))]);
    }
  }

  const database = await databaseResult;
  const transaction = database.transaction(ASSET_STORE, "readwrite");
  const store = transaction.objectStore(ASSET_STORE);

  const existingKeys = await requestToPromise(store.getAllKeys());

  for (const key of existingKeys) {
    if (typeof key === "string" && !keepPaths.has(key)) {
      store.delete(key);
    }
  }

  for (const [path, buffer] of entries) {
    store.put(buffer, path);
  }

  await transactionToPromise(transaction);
}

/**
 * Read stored bytes for the project's binary files and return them as base64,
 * keyed by path, so they can be hydrated back into the in-memory workspace.
 */
export async function loadWorkspaceAssetContents(
  project: WorkspaceProject,
): Promise<Record<string, string>> {
  const databaseResult = getDatabase();

  if (!databaseResult) {
    return {};
  }

  const paths = collectBinaryAssetPaths(project);

  if (paths.length === 0) {
    return {};
  }

  const database = await databaseResult;
  const transaction = database.transaction(ASSET_STORE, "readonly");
  const store = transaction.objectStore(ASSET_STORE);

  // Issue all reads before awaiting so the transaction stays active.
  const pendingReads = paths.map((path) => [path, store.get(path)] as const);
  const contents: Record<string, string> = {};

  await Promise.all(
    pendingReads.map(async ([path, request]) => {
      const value = await requestToPromise(request);

      if (value instanceof ArrayBuffer) {
        contents[path] = bytesToBase64(new Uint8Array(value));
      } else if (value instanceof Uint8Array) {
        contents[path] = bytesToBase64(value);
      }
    }),
  );

  await transactionToPromise(transaction);

  return contents;
}
