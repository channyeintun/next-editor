import { describe, expect, it } from "vitest";
import { FakeIndexedDB } from "./fakeIndexedDB";

// The storage tests trust this fake to behave like a browser where it matters to
// them; these cases pin that behaviour.

function open(fake: FakeIndexedDB, upgrade: (database: IDBDatabase) => void) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = fake.indexedDB.open("db", 1) as unknown as IDBOpenDBRequest;
    request.onupgradeneeded = () => upgrade(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function settle(request: IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finish(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}

describe("FakeIndexedDB", () => {
  it("rejects a request made after awaiting work outside the transaction", async () => {
    const fake = new FakeIndexedDB();
    const database = await open(fake, (db) => db.createObjectStore("items", { keyPath: "id" }));
    const transaction = database.transaction("items", "readwrite");
    await settle(transaction.objectStore("items").put({ id: 1 }));
    // Continuing on a promise resolved by a request keeps the transaction active.
    transaction.objectStore("items").put({ id: 2 });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(() => transaction.objectStore("items").put({ id: 3 })).toThrow(
      expect.objectContaining({ name: "TransactionInactiveError" }),
    );
  });

  it("rolls back a transaction whose request fails and reports the error on abort", async () => {
    const fake = new FakeIndexedDB();
    const database = await open(fake, (db) => db.createObjectStore("items", { keyPath: "id" }));
    const quota = new DOMException("full", "QuotaExceededError");
    fake.failNext({ store: "items", method: "put", error: quota });
    const transaction = database.transaction("items", "readwrite");
    const done = finish(transaction);
    const store = transaction.objectStore("items");
    store.put({ id: "kept-out" }).onerror = () => {};

    await expect(done).rejects.toBe(quota);
    expect(fake.read("db", "items")).toEqual([]);
  });

  it("walks composite keys in IndexedDB order", async () => {
    const fake = new FakeIndexedDB();
    const database = await open(fake, (db) =>
      db.createObjectStore("segments", { keyPath: ["recordingId", "seq"] }),
    );
    const write = database.transaction("segments", "readwrite");
    for (const [recordingId, seq] of [
      ["b", 0],
      ["a", 10],
      ["a", 2],
    ] as const) {
      write.objectStore("segments").put({ recordingId, seq });
    }
    await finish(write);

    const read = database.transaction("segments", "readonly");
    const range = IDBKeyRangeFor(fake).bound(["a"], ["a", []]);
    const inRange = await settle(read.objectStore("segments").getAll(range));

    expect(inRange).toEqual([
      { recordingId: "a", seq: 2 },
      { recordingId: "a", seq: 10 },
    ]);
  });
});

function IDBKeyRangeFor(fake: FakeIndexedDB) {
  return fake.IDBKeyRange as unknown as typeof IDBKeyRange;
}
