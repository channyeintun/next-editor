import { describe, expect, it, vi } from "vite-plus/test";
import { FakeIndexedDB } from "../test/fakeIndexedDB";
import { createDatabaseOpener, requestToPromise, transactionToPromise } from "./idb";

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

describe("createDatabaseOpener", () => {
  const itemsOpener = (version = 1) =>
    createDatabaseOpener({
      name: "db",
      version,
      upgrade: (database) => {
        if (!database.objectStoreNames.contains("items")) {
          database.createObjectStore("items", { keyPath: "id" });
        }
      },
      openError: "Failed to open db",
      blockedError: "db upgrade is blocked",
    });

  it("returns the same connection while it stays open", async () => {
    const fake = new FakeIndexedDB();
    const opener = itemsOpener();

    const first = opener.open(fake.indexedDB);
    expect(opener.open(fake.indexedDB)).toBe(first);
    const database = await first;
    expect(await opener.open(fake.indexedDB)).toBe(database);
    expect(Array.from(database.objectStoreNames)).toEqual(["items"]);
  });

  it("tries again after a failed open instead of handing out the failure", async () => {
    const fake = new FakeIndexedDB();
    // A newer build left the database at v2, so opening v1 fails with VersionError.
    await fake.seed("db", 2, {});
    const opener = itemsOpener();

    await expect(opener.open(fake.indexedDB)).rejects.toMatchObject({ name: "VersionError" });

    await requestToPromise(fake.indexedDB.deleteDatabase("db"));
    const database = await opener.open(fake.indexedDB);
    expect(database.version).toBe(1);
  });

  it("tries again after an upgrade an older connection blocked", async () => {
    const fake = new FakeIndexedDB();
    // An older tab's connection that does not close for the upgrade.
    const older = await requestToPromise(fake.indexedDB.open("db", 1));
    const opener = itemsOpener(2);

    await expect(opener.open(fake.indexedDB)).rejects.toThrow("db upgrade is blocked");

    older.close();
    const database = await opener.open(fake.indexedDB);
    expect(database.version).toBe(2);
    expect(Array.from(database.objectStoreNames)).toEqual(["items"]);
  });

  it("closes its connection when another one upgrades the database, so it never blocks it", async () => {
    const fake = new FakeIndexedDB();
    const opener = itemsOpener();
    const stale = await opener.open(fake.indexedDB);

    const upgrade = fake.indexedDB.open("db", 2);
    const blocked = vi.fn<() => void>();
    upgrade.onblocked = blocked;
    (await requestToPromise(upgrade)).close();

    expect(blocked).not.toHaveBeenCalled();
    // A closed connection refuses new transactions.
    expect(() => stale.transaction("items")).toThrow(
      expect.objectContaining({ name: "InvalidStateError" }),
    );
    // The cache let go of it: the next open is a new request, which meets v2.
    await expect(opener.open(fake.indexedDB)).rejects.toMatchObject({ name: "VersionError" });
  });
});
