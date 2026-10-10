import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "../core/src";
import type { StoredRecordingEntry, StoredRecordingMetadata } from "./IndexedDBRecordingStore";
import { encodeRecordingToStream } from "./recordingCodecClient";
import { getRecordingStorage, RecordingStorage } from "./RecordingStorage";

function createRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    version: 4,
    id: "recording-1",
    name: "Export test recording",
    createdAt: 1_700_000_000_000,
    duration: 1000,
    keyframeInterval: 120,
    frames: [
      {
        isKeyframe: true,
        timestamp: 0,
        state: {
          content: "hello",
          position: { lineNumber: 1, column: 1 },
          selection: {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 1,
            selectionStartLineNumber: 1,
            selectionStartColumn: 1,
            positionLineNumber: 1,
            positionColumn: 1,
          },
          viewState: null,
        },
      },
    ],
    ...overrides,
  };
}

function metadataFor(recording: Recording): StoredRecordingMetadata {
  return {
    id: recording.id,
    name: recording.name,
    version: recording.version,
    duration: recording.duration,
    createdAt: recording.createdAt,
    updatedAt: recording.createdAt,
    hasAudio: false,
    hasCamera: false,
    payloadSize: 0,
  };
}

async function entryFor(recording: Recording): Promise<StoredRecordingEntry> {
  const binaryData = await encodeRecordingToStream(recording);
  return { metadata: metadataFor(recording), binaryData };
}

/** Stub the private `indexedDBStore` so these tests don't require a real IndexedDB. */
function withStubbedStore(
  storage: RecordingStorage,
  stubs: {
    getEntry?: (id: string) => Promise<StoredRecordingEntry | null>;
  },
): void {
  const store = (storage as unknown as { indexedDBStore: Record<string, unknown> }).indexedDBStore;
  if (stubs.getEntry) store.getEntry = stubs.getEntry;
}

describe("RecordingStorage.loadById", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loadById() decodes only the requested recording", async () => {
    const storage = new RecordingStorage();
    const entry = await entryFor(createRecording({ id: "rec-a", name: "A" }));
    const getEntry = vi.fn<(id: string) => Promise<StoredRecordingEntry | null>>(async (id) =>
      id === "rec-a" ? entry : null,
    );
    withStubbedStore(storage, { getEntry });

    const loaded = await storage.loadById("rec-a");

    expect(loaded?.id).toBe("rec-a");
    expect(getEntry).toHaveBeenCalledTimes(1);
    expect(getEntry).toHaveBeenCalledWith("rec-a");
  });

  it("loadById() incrementally decodes an OPFS payload stream", async () => {
    const storage = new RecordingStorage();
    const recording = createRecording({ id: "rec-opfs", name: "OPFS" });
    const binaryData = await encodeRecordingToStream(recording);
    const entry: StoredRecordingEntry = {
      metadata: { ...metadataFor(recording), payloadStorage: "opfs" },
      binaryStream: new Blob([binaryData as BlobPart]).stream(),
    };
    const getEntry = vi
      .fn<(id: string) => Promise<StoredRecordingEntry | null>>()
      .mockResolvedValue(entry);
    withStubbedStore(storage, { getEntry });

    const loaded = await storage.loadById("rec-opfs");

    expect(loaded?.id).toBe("rec-opfs");
    expect(loaded?.frames).toEqual(recording.frames);
    expect(loaded?.streamFinalized).toBe(true);
  });

  it("loadById() returns null when the entry is missing", async () => {
    const storage = new RecordingStorage();
    withStubbedStore(storage, { getEntry: async () => null });

    const loaded = await storage.loadById("missing-id");

    expect(loaded).toBeNull();
  });
});

describe("getRecordingStorage", () => {
  it("hands every caller the same store, so they share one IndexedDB connection", () => {
    expect(getRecordingStorage()).toBe(getRecordingStorage());
    expect(getRecordingStorage()).toBeInstanceOf(RecordingStorage);
  });
});
