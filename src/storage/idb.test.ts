import { describe, expect, it } from "vitest";
import { FakeIndexedDB } from "../test/fakeIndexedDB";
import { requestToPromise, transactionToPromise } from "./idb";

async function openItems(fake: FakeIndexedDB): Promise<IDBDatabase> {
  const request = fake.indexedDB.open("db", 1) as unknown as IDBOpenDBRequest;
  request.onupgradeneeded = () => request.result.createObjectStore("items", { keyPath: "id" });
  return requestToPromise(request);
}

describe("transactionToPromise", () => {
  it("rejects with the error of the request that failed the transaction", async () => {
    const fake = new FakeIndexedDB();
    const database = await openItems(fake);
    const transaction = database.transaction("items", "readwrite");
    const done = transactionToPromise(transaction);
    const store = transaction.objectStore("items");

    store.add({ id: 1 });
    // A second add of the same key fails with ConstraintError and aborts the transaction.
    store.add({ id: 1 });

    await expect(done).rejects.toMatchObject({ name: "ConstraintError" });
  });

  it("rejects with the abort's error when the commit itself fails", async () => {
    const fake = new FakeIndexedDB();
    const database = await openItems(fake);
    const quota = new DOMException("The quota has been exceeded", "QuotaExceededError");
    fake.failNextCommit(quota);
    const transaction = database.transaction("items", "readwrite");
    const done = transactionToPromise(transaction);

    transaction.objectStore("items").put({ id: 1 });

    await expect(done).rejects.toBe(quota);
  });
});
