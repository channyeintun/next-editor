import { IDBDatabase, IDBFactory, IDBKeyRange } from "fake-indexeddb";

/**
 * A fresh in-memory IndexedDB per test (fake-indexeddb, which implements the
 * spec), plus the few things tests need beyond the standard API: seeding a
 * database as an older build left it, reading or clearing a store behind the
 * code under test's back, and making a commit fail the way a browser's does
 * when the disk write runs over quota.
 *
 * fake-indexeddb stores values with the global structuredClone. Under jsdom that
 * is Node's, which does not know jsdom's Blob and turns it into `{}`, so tests
 * that store Blobs run in the node environment.
 */

/** The parts of fake-indexeddb's transaction that a commit-time fault reaches into. */
interface FakeTransactionInternals {
  mode: IDBTransactionMode;
  error: DOMException | null;
  _state: string;
  _requests: Array<{ request: { readyState: string } }>;
  _start(): void;
  _abort(errorName: string | null): void;
}

const pendingCommitFaults: DOMException[] = [];

// Hands the next readwrite transaction a pending commit fault, if any: once every
// request has succeeded, it rolls back and aborts with the fault instead of completing.
const createTransaction = IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction = function transaction(
  this: IDBDatabase,
  ...args: Parameters<IDBDatabase["transaction"]>
): IDBTransaction {
  const created = createTransaction.apply(this, args);
  const fault = created.mode === "readwrite" ? pendingCommitFaults.shift() : undefined;
  if (fault) {
    const internals = created as unknown as FakeTransactionInternals;
    const start = internals._start.bind(internals);
    internals._start = () => {
      const committing =
        internals._state !== "finished" &&
        internals._requests.every(({ request }) => request.readyState === "done");
      if (!committing) {
        start();
        return;
      }
      internals._abort(fault.name);
      // _abort queues the abort event; the caller's own error object is what it carries.
      internals.error = fault;
    };
  }
  return created;
};

export interface SeedStore {
  keyPath?: string | string[];
  /** Inline-key stores take values; out-of-line stores take `{ key, value }`. */
  records: unknown[];
}

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}

export class FakeIndexedDB {
  /** Pass to `vi.stubGlobal("indexedDB", ...)`. */
  readonly indexedDB = new IDBFactory();

  /** Pass to `vi.stubGlobal("IDBKeyRange", ...)`. */
  readonly IDBKeyRange = IDBKeyRange;

  constructor() {
    pendingCommitFaults.length = 0;
  }

  /** Makes the next readwrite transaction abort with `error` when it would commit. */
  failNextCommit(error: DOMException): void {
    pendingCommitFaults.push(error);
  }

  /** Creates a database as an older build would have left it. */
  async seed(name: string, version: number, stores: Record<string, SeedStore>): Promise<void> {
    const request = this.indexedDB.open(name, version);
    request.onupgradeneeded = () => {
      for (const [storeName, { keyPath, records }] of Object.entries(stores)) {
        const store = request.result.createObjectStore(storeName, keyPath ? { keyPath } : {});
        for (const record of records) {
          if (keyPath) {
            store.put(record);
          } else {
            const { key, value } = record as { key: IDBValidKey; value: unknown };
            store.put(value, key);
          }
        }
      }
    };
    (await settle(request)).close();
  }

  /** The values currently in a store, in key order; none when it does not exist. */
  async read(name: string, storeName: string): Promise<unknown[]> {
    // Opening a database that does not exist would create it, so look first.
    const databases = await this.indexedDB.databases();
    if (!databases.some((database) => database.name === name)) return [];
    const database = await settle(this.indexedDB.open(name));
    try {
      if (!database.objectStoreNames.contains(storeName)) return [];
      const transaction = database.transaction(storeName, "readonly");
      return await settle(transaction.objectStore(storeName).getAll());
    } finally {
      database.close();
    }
  }

  /** Empties a store behind the code under test's back (e.g. site data cleared). */
  async clear(name: string, storeName: string): Promise<void> {
    const database = await settle(this.indexedDB.open(name));
    try {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).clear();
      await finished(transaction);
    } finally {
      database.close();
    }
  }
}
