import { afterEach, describe, expect, it, vi } from "vitest";
import type { Recording } from "../core/src";
import type { StoredRecordingEntry, StoredRecordingMetadata } from "./IndexedDBRecordingStore";
import { decompressBinaryToRecording, encodeRecordingToStream } from "./recordingCodecClient";
import { attachCompanionAudio, buildRecordingFiles, RecordingStorage } from "./RecordingStorage";

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

const downloads = vi.hoisted(() => ({ saved: [] as Array<{ filename: string; blob: Blob }> }));

vi.mock("../utils/downloadBlob", () => ({
  downloadBlob: (blob: Blob, filename: string) => {
    downloads.saved.push({ filename, blob });
  },
}));

async function exportAndDecode(recording: Recording, filename?: string): Promise<Recording> {
  const storage = new RecordingStorage();
  const downloaded = downloads.saved;
  downloaded.length = 0;

  await storage.exportAsFile(recording, filename);

  const neEntry = downloaded.find((entry) => entry.filename.endsWith(".ne"));
  if (!neEntry) throw new Error("Expected a .ne download");
  const bytes = new Uint8Array(await neEntry.blob.arrayBuffer());
  return decompressBinaryToRecording(bytes);
}

describe("buildRecordingFiles", () => {
  it("returns only a .ne blob for a recording with no media", async () => {
    const recording = createRecording();
    const files = await buildRecordingFiles(recording, "my-lesson");

    expect(files.audio).toBeUndefined();
    expect(files.camera).toBeUndefined();
    const bytes = new Uint8Array(await files.ne.arrayBuffer());
    const decoded = await decompressBinaryToRecording(bytes);
    expect(decoded.id).toBe(recording.id);
  });

  it("externalizes audio/camera blobs under the given baseFilename", async () => {
    const audioBlob = new Blob(["audio"], { type: "audio/ogg" });
    const cameraBlob = new Blob(["camera"], { type: "video/webm" });
    const recording = createRecording({ audioBlob, cameraBlob });

    const files = await buildRecordingFiles(recording, "my-lesson");

    expect(files.audio).toEqual({ name: "my-lesson.ogg", blob: audioBlob });
    expect(files.camera).toEqual({ name: "my-lesson.webm", blob: cameraBlob });
  });

  it("declares sibling caption files in the encoded .ne, replacing any stale declaration", async () => {
    const recording = createRecording({ captionFiles: ["stale.en.vtt"] });

    const withCaptions = await buildRecordingFiles(recording, "lesson-1", {
      captionFiles: ["lesson-1.en.vtt", "lesson-1.my.vtt"],
    });
    const decodedWith = await decompressBinaryToRecording(
      new Uint8Array(await withCaptions.ne.arrayBuffer()),
    );
    expect(decodedWith.captionFiles).toEqual(["lesson-1.en.vtt", "lesson-1.my.vtt"]);

    // Without the option (the plain export path) the existing declaration is preserved.
    const withoutOption = await buildRecordingFiles(recording, "lesson-1");
    const decodedWithout = await decompressBinaryToRecording(
      new Uint8Array(await withoutOption.ne.arrayBuffer()),
    );
    expect(decodedWithout.captionFiles).toEqual(["stale.en.vtt"]);
  });

  it("produces byte-identical .ne output to exportAsFile for the same recording", async () => {
    const recording = createRecording();
    const viaBuild = await buildRecordingFiles(recording, "recording-1");
    const viaExport = await exportAndDecode(recording);
    const decodedFromBuild = await decompressBinaryToRecording(
      new Uint8Array(await viaBuild.ne.arrayBuffer()),
    );

    expect(decodedFromBuild.id).toBe(viaExport.id);
    expect(decodedFromBuild.frames).toEqual(viaExport.frames);
  });
});

describe("RecordingStorage.exportAsFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips blob: cameraUrl/audioUrl before encoding — they'd defeat sibling resolution on next load", async () => {
    const recording = createRecording({
      cameraFile: "lesson.webm",
      cameraUrl: "blob:https://example.com/1234-5678",
      audioFile: "lesson.weba",
      audioUrl: "blob:https://example.com/abcd-efgh",
    });

    const decoded = await exportAndDecode(recording, "lesson");

    expect(decoded.cameraUrl).toBeUndefined();
    expect(decoded.audioUrl).toBeUndefined();
    // Sibling filenames still get written so basename/same-folder resolution keeps working.
    expect(decoded.cameraFile).toBe("lesson.webm");
    expect(decoded.audioFile).toBe("lesson.weba");
  });

  it("strips data: cameraUrl/audioUrl the same way", async () => {
    const recording = createRecording({
      audioFile: "lesson.weba",
      audioUrl: "data:audio/webm;base64,AAAA",
    });

    const decoded = await exportAndDecode(recording, "lesson");

    expect(decoded.audioUrl).toBeUndefined();
  });

  it("strips an https:// URL auto-resolved from a prior ?url= load (stale-host bug)", async () => {
    // This is what `useUrlLoader`'s `withResolvedMediaUrls` produces — it can't survive a
    // re-export as-is, since a present `cameraUrl`/`audioUrl` is preferred over the sibling
    // filename on the next load.
    const recording = createRecording({
      audioFile: "lesson.weba",
      audioUrl: "https://old-host.example.com/lesson.weba",
      cameraFile: "lesson.webm",
      cameraUrl: "https://old-host.example.com/lesson.webm",
    });

    const decoded = await exportAndDecode(recording, "lesson");

    expect(decoded.audioUrl).toBeUndefined();
    expect(decoded.cameraUrl).toBeUndefined();
    expect(decoded.audioFile).toBe("lesson.weba");
    expect(decoded.cameraFile).toBe("lesson.webm");
  });
});

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

describe("attachCompanionAudio", () => {
  it("matches a companion audio file by .ne basename when external audio is declared without a filename", () => {
    // Older exports wrote `audioSource: "external"` without persisting `audioFile` — a
    // basename-matching companion picked alongside the `.ne` must still attach.
    const recording = createRecording({ audioSource: "external" });
    const audio = new File([new Uint8Array([1, 2, 3]) as BlobPart], "introduction.weba", {
      type: "audio/webm",
    });

    const attached = attachCompanionAudio(recording, [audio], "introduction.ne");

    expect(attached.audioBlob).toBe(audio);
  });

  it("does not attach audio to a recording that declares no audio at all", () => {
    const recording = createRecording();
    const audio = new File([new Uint8Array([1]) as BlobPart], "introduction.weba", {
      type: "audio/webm",
    });

    const attached = attachCompanionAudio(recording, [audio], "introduction.ne");

    expect(attached.audioBlob).toBeUndefined();
  });
});

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
