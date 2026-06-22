// Shared IndexedDB plumbing used by the recording store and the workspace asset
// store. Both stores wrap the same callback-based IDB request/transaction API in
// promises and copy Uint8Arrays into standalone ArrayBuffers before persisting;
// these helpers are the single source of truth for that boilerplate.

/** Resolves/rejects when an IDB request settles. */
export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/** Resolves when an IDB transaction completes; rejects if it errors or aborts. */
export function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
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
