// The page's store of large modules' prepared forms (the kernel's entries,
// kernel/preparedModules.ts), kept between visits in IndexedDB. It lives on
// the editor's origin, where nothing a project runs can reach: only the
// kernel's own entries arrive here, over the page's port to it (api.ts).
//
// An entry belongs to a version (the rewrite that made it,
// process/loader/preparedEntry.ts): another version's entries are never
// answered with, and are removed when one is kept. The store never fails its
// caller: where IndexedDB is missing, refused or full, nothing is found and
// nothing is kept.

/** What the store keeps for an entry beside its bytes. */
interface EntryRecord {
  key: string;
  version: string;
  size: number;
  /** When it was last asked for or kept. */
  usedAt: number;
}

export interface PreparedStorage {
  /** The entry kept under `key` for `version`, or null. */
  get(version: string, key: string): Promise<Uint8Array | null>;
  /** Keeps `entry` under `key` for `version`, dropping what was least lately used to make room. */
  put(version: string, key: string, entry: Uint8Array): Promise<void>;
}

const DATABASE = "webnode-prepared-modules";
const RECORDS = "records";
const ENTRIES = "entries";
/** All the entries together: a few megabytes a dependency setup, and a learner meets a handful. */
const CAPACITY_BYTES = 96 * 1024 * 1024;

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("the request failed"));
  });
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("the transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("the transaction failed"));
  });
}

/**
 * The store in `factory` (the page's `indexedDB`), holding `capacity` bytes
 * of entries at most.
 */
export function openPreparedStorage(
  factory: IDBFactory | undefined = globalThis.indexedDB,
  capacity: number = CAPACITY_BYTES,
): PreparedStorage {
  let opening: Promise<IDBDatabase> | null = null;
  const database = (): Promise<IDBDatabase> => {
    if (!factory) {
      return Promise.reject(new Error("no IndexedDB"));
    }
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(RECORDS, { keyPath: "key" });
        request.result.createObjectStore(ENTRIES);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB did not open"));
      request.onblocked = () => reject(new Error("IndexedDB is blocked"));
    });
    return opening;
  };

  return {
    async get(version, key) {
      try {
        const transaction = (await database()).transaction([RECORDS, ENTRIES], "readwrite");
        const done = completed(transaction);
        const records = transaction.objectStore(RECORDS);
        const record = (await settled(records.get(key))) as EntryRecord | undefined;
        if (!record || record.version !== version) {
          await done;
          return null;
        }
        const entry = (await settled(transaction.objectStore(ENTRIES).get(key))) as
          | ArrayBuffer
          | undefined;
        records.put({ ...record, usedAt: Date.now() } satisfies EntryRecord);
        await done;
        return entry ? new Uint8Array(entry) : null;
      } catch {
        return null;
      }
    },
    async put(version, key, entry) {
      try {
        const transaction = (await database()).transaction([RECORDS, ENTRIES], "readwrite");
        const done = completed(transaction);
        const records = transaction.objectStore(RECORDS);
        const entries = transaction.objectStore(ENTRIES);
        const kept = ((await settled(records.getAll())) as EntryRecord[])
          .filter((record) => record.key !== key)
          .sort((a, b) => b.usedAt - a.usedAt);
        // Another version's entries first, then the least lately used.
        let room = capacity - entry.length;
        for (const record of kept) {
          if (record.version === version && record.size <= room) {
            room -= record.size;
          } else {
            records.delete(record.key);
            entries.delete(record.key);
          }
        }
        if (room >= 0) {
          records.put({
            key,
            version,
            size: entry.length,
            usedAt: Date.now(),
          } satisfies EntryRecord);
          // A copy of exactly the entry's bytes, whatever buffer they came in.
          entries.put(entry.slice().buffer, key);
        }
        await done;
      } catch {
        // Nothing is kept: the next visit prepares the module again.
      }
    },
  };
}
