// Shared IndexedDB plumbing used by the recording store, the workspace asset store,
// the learner workspace versions and the recording drafts: the cached database
// opener, promise wrappers for the callback-based request/transaction API, and the
// helper that copies bytes into a standalone ArrayBuffer before they are stored.

/** Resolves/rejects when an IDB request settles. */
export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/**
 * Resolves when an IDB transaction completes; rejects when it aborts. A request that
 * fails aborts its transaction, and the abort carries that request's error. (The
 * request's error event reaches the transaction first, but before the abort has set
 * transaction.error, so rejecting there would lose the cause.)
 */
export function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/**
 * Copies bytes into a standalone ArrayBuffer. A view's underlying buffer may be a
 * slice of a larger/transferable buffer, so the copy guarantees IndexedDB stores
 * exactly these bytes.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export interface DatabaseOpenerOptions {
  name: string;
  version: number;
  /** Creates or migrates the stores; runs inside the open request's upgrade transaction. */
  upgrade: (database: IDBDatabase, transaction: IDBTransaction | null, oldVersion: number) => void;
  /** Rejection message when the open request fails without an error of its own. */
  openError: string;
  /** Rejection message when an older connection blocks the upgrade. */
  blockedError: string;
}

export interface DatabaseOpener {
  /** The cached connection, opening it on first use. */
  open(factory: IDBFactory): Promise<IDBDatabase>;
  /** Drops the cached connection, closing it once it opens; for tests that swap factories. */
  reset(): void;
}

/**
 * One database's cached connection. A failed or blocked open clears the cache
 * before it rejects, so the next call tries again: otherwise every later read
 * and write would get the same rejected promise for the rest of the session,
 * long after the blocking connection has gone, and only a reload would recover.
 * A versionchange (another tab upgrading the database) closes this connection
 * and clears the cache too, so this tab never blocks that upgrade and reopens
 * at the new version on its next call.
 */
export function createDatabaseOpener(options: DatabaseOpenerOptions): DatabaseOpener {
  let databasePromise: Promise<IDBDatabase> | null = null;

  const openDatabase = (factory: IDBFactory): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = factory.open(options.name, options.version);

      request.onupgradeneeded = (event) => {
        options.upgrade(
          request.result,
          request.transaction,
          (event as IDBVersionChangeEvent).oldVersion,
        );
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
        reject(request.error ?? new Error(options.openError));
      };
      request.onblocked = () => {
        databasePromise = null;
        reject(new Error(options.blockedError));
      };
    });

  return {
    open(factory) {
      databasePromise ??= openDatabase(factory);
      return databasePromise;
    },
    reset() {
      const pending = databasePromise;
      databasePromise = null;
      void pending?.then((database) => database.close()).catch(() => undefined);
    },
  };
}
