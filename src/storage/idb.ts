// Shared IndexedDB plumbing used by the recording store and the workspace asset
// store: promise wrappers for the callback-based request/transaction API, and the
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
