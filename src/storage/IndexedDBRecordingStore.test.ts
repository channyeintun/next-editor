import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeIndexedDB } from "../test/fakeIndexedDB";
import {
  IndexedDBRecordingStore,
  RECORDING_OPFS_THRESHOLD_BYTES,
  type StoredRecordingEntry,
} from "./IndexedDBRecordingStore";

const opfs = vi.hoisted(() => ({
  isRecordingOpfsAvailable: vi.fn<() => Promise<boolean>>(),
  replaceRecordingOpfs: vi.fn<(id: string, bytes: Uint8Array) => Promise<number>>(),
  openRecordingOpfsStream: vi.fn<(id: string) => Promise<ReadableStream<Uint8Array> | null>>(),
  deleteRecordingOpfs: vi.fn<(id: string) => Promise<void>>(),
  clearRecordingOpfs: vi.fn<() => Promise<void>>(),
}));

vi.mock("./recordingOpfs", () => opfs);

const DATABASE = "next-editor-recordings-db";

let fake: FakeIndexedDB;

beforeEach(() => {
  fake = new FakeIndexedDB();
  vi.stubGlobal("indexedDB", fake.indexedDB);
  vi.stubGlobal("IDBKeyRange", fake.IDBKeyRange);
  opfs.isRecordingOpfsAvailable.mockResolvedValue(false);
  opfs.replaceRecordingOpfs.mockImplementation(async (_id, bytes) => bytes.byteLength);
  opfs.openRecordingOpfsStream.mockResolvedValue(null);
  opfs.deleteRecordingOpfs.mockResolvedValue();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function entry(
  id: string,
  binaryData: Uint8Array,
  media: Pick<StoredRecordingEntry, "cameraBlob" | "audioBlob"> = {},
): StoredRecordingEntry {
  return {
    metadata: {
      id,
      name: `Take ${id}`,
      version: 4,
      duration: 1_000,
      createdAt: 1,
      updatedAt: 2,
      hasAudio: Boolean(media.audioBlob),
      hasCamera: Boolean(media.cameraBlob),
      payloadSize: binaryData.byteLength,
    },
    binaryData,
    ...media,
  };
}

describe("IndexedDBRecordingStore", () => {
  it("stores a take and reads back its payload and media", async () => {
    const store = new IndexedDBRecordingStore();
    const camera = new Blob(["camera"], { type: "video/webm" });
    const audio = new Blob(["audio"], { type: "audio/webm" });

    await store.put(
      entry("take-1", new Uint8Array([1, 2, 3]), { cameraBlob: camera, audioBlob: audio }),
    );
    const stored = await store.getEntry("take-1");

    expect(stored?.metadata).toMatchObject({
      id: "take-1",
      payloadSize: 3,
      payloadStorage: "indexeddb",
    });
    expect(Array.from(stored?.binaryData ?? [])).toEqual([1, 2, 3]);
    expect(stored?.binaryStream).toBeUndefined();
    expect(stored?.cameraBlob).toBe(camera);
    expect(stored?.audioBlob).toBe(audio);
    // A stale OPFS copy from an earlier, larger save of the same id is removed.
    expect(opfs.deleteRecordingOpfs).toHaveBeenCalledWith("take-1");
  });

  it("returns null for an id it never stored", async () => {
    const store = new IndexedDBRecordingStore();
    await store.put(entry("take-1", new Uint8Array([1])));

    expect(await store.getEntry("take-2")).toBeNull();
  });

  it("replaces a take saved again under the same id, media included", async () => {
    const store = new IndexedDBRecordingStore();
    await store.put(
      entry("take-1", new Uint8Array([1, 2, 3]), { cameraBlob: new Blob(["camera"]) }),
    );

    await store.put(entry("take-1", new Uint8Array([9])));
    const stored = await store.getEntry("take-1");

    expect(Array.from(stored?.binaryData ?? [])).toEqual([9]);
    expect(stored?.cameraBlob).toBeUndefined();
    expect(fake.read(DATABASE, "recording-segments")).toHaveLength(1);
  });

  it("stores a payload at the OPFS threshold in OPFS and streams it back", async () => {
    opfs.isRecordingOpfsAvailable.mockResolvedValue(true);
    const payload = new Uint8Array(RECORDING_OPFS_THRESHOLD_BYTES);
    const stream = new Blob([new Uint8Array([7])]).stream();
    opfs.openRecordingOpfsStream.mockResolvedValue(stream);
    const store = new IndexedDBRecordingStore();

    await store.put(entry("large", payload));
    const stored = await store.getEntry("large");

    expect(opfs.replaceRecordingOpfs).toHaveBeenCalledTimes(1);
    const [opfsId, opfsBytes] = opfs.replaceRecordingOpfs.mock.calls[0];
    expect(opfsId).toBe("large");
    expect(opfsBytes).toBe(payload);
    expect(stored?.metadata).toMatchObject({
      payloadStorage: "opfs",
      payloadSize: RECORDING_OPFS_THRESHOLD_BYTES,
    });
    expect(stored?.binaryData).toBeUndefined();
    expect(stored?.binaryStream).toBe(stream);
    expect(fake.read(DATABASE, "recording-segments")).toEqual([]);
    expect(opfs.deleteRecordingOpfs).not.toHaveBeenCalled();
  });

  it("keeps a large payload in IndexedDB when OPFS cannot take it", async () => {
    opfs.isRecordingOpfsAvailable.mockResolvedValue(true);
    opfs.replaceRecordingOpfs.mockRejectedValue(new DOMException("full", "QuotaExceededError"));
    const payload = new Uint8Array(RECORDING_OPFS_THRESHOLD_BYTES);
    payload[payload.length - 1] = 5;
    const store = new IndexedDBRecordingStore();

    await store.put(entry("large", payload));
    const stored = await store.getEntry("large");

    expect(stored?.metadata.payloadStorage).toBe("indexeddb");
    expect(stored?.binaryData?.byteLength).toBe(RECORDING_OPFS_THRESHOLD_BYTES);
    expect(stored?.binaryData?.[RECORDING_OPFS_THRESHOLD_BYTES - 1]).toBe(5);
    expect(opfs.deleteRecordingOpfs).toHaveBeenCalledWith("large");
  });

  it("removes the OPFS copy of a save whose transaction fails", async () => {
    opfs.isRecordingOpfsAvailable.mockResolvedValue(true);
    fake.failNextCommit(new DOMException("The quota has been exceeded", "QuotaExceededError"));
    const store = new IndexedDBRecordingStore();

    await expect(
      store.put(
        entry("large", new Uint8Array(RECORDING_OPFS_THRESHOLD_BYTES), {
          cameraBlob: new Blob(["camera"]),
        }),
      ),
    ).rejects.toThrow("The quota has been exceeded");

    expect(opfs.replaceRecordingOpfs).toHaveBeenCalledTimes(1);
    // No metadata row points at the file, so it must not outlive the failed save.
    expect(opfs.deleteRecordingOpfs).toHaveBeenCalledWith("large");
    expect(await store.getEntry("large")).toBeNull();
  });

  it("writes nothing for an entry without a finalized payload", async () => {
    opfs.isRecordingOpfsAvailable.mockResolvedValue(true);
    const store = new IndexedDBRecordingStore();
    const unfinished = { ...entry("take-1", new Uint8Array([1])), binaryData: undefined };

    await expect(store.put(unfinished)).rejects.toThrow(/no finalized binary payload/);

    expect(opfs.replaceRecordingOpfs).not.toHaveBeenCalled();
    expect(fake.read(DATABASE, "recording-metadata")).toEqual([]);
  });

  it("deletes every row of a take and its OPFS file", async () => {
    const store = new IndexedDBRecordingStore();
    await store.put(
      entry("take-1", new Uint8Array([1]), {
        cameraBlob: new Blob(["camera"]),
        audioBlob: new Blob(["audio"]),
      }),
    );
    await store.put(entry("take-2", new Uint8Array([2])));
    opfs.deleteRecordingOpfs.mockClear();

    await store.delete("take-1");

    expect(await store.getEntry("take-1")).toBeNull();
    expect(Array.from((await store.getEntry("take-2"))?.binaryData ?? [])).toEqual([2]);
    for (const storeName of [
      "recording-metadata",
      "recording-segments",
      "recording-stream-state",
      "recording-camera",
      "recording-audio",
    ]) {
      const rows = fake.read(DATABASE, storeName) as Array<{ id?: string; recordingId?: string }>;
      expect(rows.some((row) => (row.id ?? row.recordingId) === "take-1")).toBe(false);
    }
    expect(opfs.deleteRecordingOpfs).toHaveBeenCalledWith("take-1");
  });

  it("keeps recordings written by a v6 build, reading their segments in order", async () => {
    fake.seed(DATABASE, 6, {
      "recording-metadata": {
        keyPath: "id",
        records: [
          {
            id: "old",
            name: "Old take",
            version: 4,
            duration: 1_000,
            createdAt: 1,
            updatedAt: 1,
            hasAudio: false,
            hasCamera: false,
            payloadSize: 4,
          },
        ],
      },
      "recording-segments": {
        keyPath: ["recordingId", "seq"],
        records: [
          { recordingId: "old", seq: 1, bytes: new Uint8Array([3, 4]).buffer },
          { recordingId: "old", seq: 0, bytes: new Uint8Array([1, 2]).buffer },
        ],
      },
      "recording-stream-state": {
        keyPath: "recordingId",
        records: [{ recordingId: "old", nextSeq: 2 }],
      },
      "recording-camera": { keyPath: "recordingId", records: [] },
      "recording-audio": { keyPath: "recordingId", records: [] },
    });
    const store = new IndexedDBRecordingStore();

    const stored = await store.getEntry("old");

    expect(Array.from(stored?.binaryData ?? [])).toEqual([1, 2, 3, 4]);
    expect(stored?.metadata.payloadStorage).toBeUndefined();
  });
});
