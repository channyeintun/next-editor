// @vitest-environment node
// The page's store of large modules' entries, on an IndexedDB of its own for
// each test.
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { openPreparedStorage } from "./preparedStorage";

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

describe("the page's store of prepared modules", () => {
  it("gives back what it was given, to a later page too", async () => {
    const factory = new IDBFactory();
    const store = openPreparedStorage(factory);
    await store.put("v1", "a", bytes(1000, 7));
    expect(await store.get("v1", "a")).toEqual(bytes(1000, 7));
    expect(await store.get("v1", "b")).toBeNull();
    expect(await openPreparedStorage(factory).get("v1", "a")).toEqual(bytes(1000, 7));
  });

  it("keeps exactly the entry's bytes when they are part of a larger buffer", async () => {
    const store = openPreparedStorage(new IDBFactory());
    const whole = bytes(100, 1);
    whole.fill(9, 10, 20);
    await store.put("v1", "a", whole.subarray(10, 20));
    expect(await store.get("v1", "a")).toEqual(bytes(10, 9));
  });

  it("answers with no other version's entry, and drops them when one is kept", async () => {
    const factory = new IDBFactory();
    const store = openPreparedStorage(factory);
    await store.put("v1", "a", bytes(10, 1));
    await store.put("v1", "b", bytes(10, 2));
    expect(await store.get("v2", "a")).toBeNull();
    await store.put("v2", "c", bytes(10, 3));
    expect(await store.get("v1", "a")).toBeNull();
    expect(await store.get("v1", "b")).toBeNull();
    expect(await store.get("v2", "c")).toEqual(bytes(10, 3));
  });

  it("drops what was least lately used to make room, and an entry too large altogether", async () => {
    const clock = vi.spyOn(Date, "now");
    const store = openPreparedStorage(new IDBFactory(), 250);
    clock.mockReturnValue(1);
    await store.put("v1", "old", bytes(100, 1));
    clock.mockReturnValue(2);
    await store.put("v1", "newer", bytes(100, 2));
    // Asked for again: `old` is now the one used last.
    clock.mockReturnValue(3);
    expect(await store.get("v1", "old")).toEqual(bytes(100, 1));
    clock.mockReturnValue(4);
    await store.put("v1", "newest", bytes(100, 3));
    expect(await store.get("v1", "newer")).toBeNull();
    expect(await store.get("v1", "old")).toEqual(bytes(100, 1));
    expect(await store.get("v1", "newest")).toEqual(bytes(100, 3));

    await store.put("v1", "huge", bytes(251, 4));
    expect(await store.get("v1", "huge")).toBeNull();
    clock.mockRestore();
  });

  it("finds and keeps nothing, quietly, where there is no IndexedDB or it fails", async () => {
    const none = openPreparedStorage(undefined);
    await none.put("v1", "a", bytes(10, 1));
    expect(await none.get("v1", "a")).toBeNull();

    const refusing = {
      open() {
        throw new Error("refused");
      },
    } as unknown as IDBFactory;
    const refused = openPreparedStorage(refusing);
    await refused.put("v1", "a", bytes(10, 1));
    expect(await refused.get("v1", "a")).toBeNull();
  });
});
