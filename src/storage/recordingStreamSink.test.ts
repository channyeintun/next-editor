import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Recording, RecordingStreamSink } from "../core/src/types";
import type { RecordingSession } from "../core/src/machine/types";
import type { WorkspaceProject } from "../types/workspace";
import { RecordingStreamBridge } from "./recordingStreamSink";
import { registerWorkspaceAsset, resetWorkspaceAssetStoreForTests } from "./workspaceAssetStore";
import {
  createStreamingRecordingWriter,
  createStreamingRecordingReader,
  decodeRecordingStream,
  encodeRecordingToStream,
  RECORDING_EVENT_SEGMENTS,
  SEGMENT_KIND,
  type RecordingStreamMeta,
} from "./streamingRecordingCodec";

function makeFrame(timestamp: number, content: string) {
  return {
    isKeyframe: true as const,
    timestamp,
    state: {
      content,
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
  };
}

const project: WorkspaceProject = {
  id: "stream-project",
  name: "Stream project",
  lessonType: "html-css",
  entryFilePath: "index.html",
  folders: [],
  files: {
    "index.html": {
      path: "index.html",
      name: "index.html",
      language: "html",
      content: "<main>stream</main>",
    },
  },
};

function makeRecording(): Recording {
  return {
    version: 4,
    id: "live-stream",
    name: "Live stream",
    createdAt: 1_700_000_000_000,
    duration: 5_000,
    keyframeInterval: 120,
    frames: [makeFrame(0, "one"), makeFrame(1_000, "two")],
    slideEvents: [{ timestamp: 100, type: "slide_open", slideId: "slide-1" }],
    previewEvents: [{ timestamp: 200, type: "preview_open", isOpen: true }],
    previewInitialDocuments: [{ version: 1, time: 250, documentId: "doc-1", route: "/" }],
    previewPatchBatches: [
      { version: 1, time: 300, source: "runtime-preview", documentId: "doc-1" },
    ],
    workspaceEvents: [
      {
        timestamp: 400,
        snapshot: {
          project,
          activeFilePath: "index.html",
          collapsedFolders: [],
          sidebarScrollTop: 0,
        },
      },
    ],
    runtimeEvents: [{ timestamp: 500, snapshot: { mode: "webcontainer", status: "ready" } }],
    cursorEvents: [{ timestamp: 600, x: 10, y: 20, visible: true }],
    whiteboardEvents: [
      {
        timestamp: 700,
        upserts: [
          { id: "shape-1", version: 1, versionNonce: 2, isDeleted: false, type: "rectangle" },
        ],
        isOpen: true,
      },
    ],
    chatEvents: [{ timestamp: 800, event: { k: "draft", text: "hello" } }],
    slides: [{ id: "slide-1", content: "# Stream", contentType: "markdown", order: 0 }],
    captions: [{ id: "captions-en", language: "en", cues: [{ start: 0, end: 1_000, text: "Hi" }] }],
    audioFile: "live-stream.weba",
    audioSource: "external",
    audioStartOffsetMs: 25,
    cameraFile: "live-stream.webm",
    cameraSource: "camera",
    cameraStartOffsetMs: 50,
  };
}

function makeSession(recording: Recording): RecordingSession {
  return {
    startedAt: recording.createdAt,
    startedAtPerf: 0,
    frames: recording.frames,
    encoder: {} as RecordingSession["encoder"],
    slideEvents: recording.slideEvents ?? [],
    previewEvents: recording.previewEvents ?? [],
    previewInitialDocuments: recording.previewInitialDocuments ?? [],
    previewPatchBatches: recording.previewPatchBatches ?? [],
    workspaceEvents: recording.workspaceEvents ?? [],
    runtimeEvents: recording.runtimeEvents ?? [],
    cursorEvents: recording.cursorEvents ?? [],
    whiteboardEvents: recording.whiteboardEvents ?? [],
    chatEvents: recording.chatEvents ?? [],
    audioFragments: [],
    lastMousePosition: { x: 0, y: 0, visible: false },
  };
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

afterEach(() => resetWorkspaceAssetStoreForTests());

describe("RecordingStreamBridge", () => {
  it("uses one canonical event-track contract for live and one-shot streams", () => {
    expect(RECORDING_EVENT_SEGMENTS.map(({ key }) => key)).toEqual([
      "slideEvents",
      "previewEvents",
      "previewInitialDocuments",
      "previewPatchBatches",
      "workspaceEvents",
      "runtimeEvents",
      "cursorEvents",
      "whiteboardEvents",
      "chatEvents",
    ]);
  });

  it("matches one-shot SCR3 semantics for every event track and final metadata", async () => {
    const recording = makeRecording();
    const chunks: Uint8Array[] = [];
    const sink: RecordingStreamSink = {
      write: (chunk) => {
        chunks.push(chunk.slice());
      },
      close: vi.fn<() => void>(),
    };
    const bridge = new RecordingStreamBridge(sink);
    const session = makeSession(recording);

    bridge.start(session, {
      audioType: "audio/webm",
      audioSource: "external",
      audioStartOffsetMs: 25,
      cameraType: "video/webm",
      cameraSource: "camera",
      cameraStartOffsetMs: 50,
    });
    bridge.sync(session);
    await bridge.finish(recording);

    const live = decodeRecordingStream(concatChunks(chunks));
    const oneShot = decodeRecordingStream(await encodeRecordingToStream(recording));
    const semanticKeys = [
      "frames",
      "slideEvents",
      "previewEvents",
      "previewInitialDocuments",
      "previewPatchBatches",
      "workspaceEvents",
      "runtimeEvents",
      "cursorEvents",
      "whiteboardEvents",
      "chatEvents",
      "duration",
      "slides",
      "captions",
      "tracks",
      "clusters",
      "audioFile",
      "audioSource",
      "audioStartOffsetMs",
      "cameraFile",
      "cameraSource",
      "cameraStartOffsetMs",
    ] as const;

    for (const key of semanticKeys) {
      expect(live[key]).toEqual(oneShot[key]);
    }
    expect(live.duration).toBe(5_000);
    expect(live.streamFinalized).toBe(true);
    expect(sink.close).toHaveBeenCalledTimes(1);
  });

  it("streams each descriptor-backed workspace asset exactly once", async () => {
    const assetBytes = new Uint8Array([1, 2, 3, 4]);
    const descriptor = await registerWorkspaceAsset(assetBytes, { mimeType: "image/png" });
    const recording = makeRecording();
    const assetProject = structuredClone(project);
    assetProject.files["logo.png"] = {
      path: "logo.png",
      name: "logo.png",
      language: "binary",
      content: descriptor,
      encoding: "asset",
    };
    recording.workspaceEvents![0].snapshot.project = assetProject;
    const chunks: Uint8Array[] = [];
    const bridge = new RecordingStreamBridge({
      write: (chunk) => {
        chunks.push(chunk.slice());
      },
      close: vi.fn<() => void>(),
    });
    const session = makeSession(recording);

    bridge.start(session);
    bridge.sync(session);
    await bridge.finish(recording);

    const decoded = decodeRecordingStream(concatChunks(chunks));
    expect(decoded.workspaceAssets).toEqual([{ descriptor, bytes: assetBytes }]);
    expect(decoded.workspaceEvents?.[0].snapshot.project.files["logo.png"].content).toEqual(
      descriptor,
    );
  });

  it("applies one-write-at-a-time backpressure and closes exactly once", async () => {
    const recording = makeRecording();
    const firstWrite: { release: (() => void) | null } = { release: null };
    let markFirstWriteStarted!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve;
    });
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    let writeCount = 0;
    const sink: RecordingStreamSink = {
      write: async () => {
        writeCount += 1;
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        if (writeCount === 1) {
          markFirstWriteStarted();
          await new Promise<void>((resolve) => {
            firstWrite.release = resolve;
          });
        }
        activeWrites -= 1;
      },
      close: vi.fn<() => void>(),
    };
    const bridge = new RecordingStreamBridge(sink);
    const session = makeSession(recording);

    bridge.start(session);
    bridge.sync(session);
    const finish = bridge.finish(recording);
    await firstWriteStarted;
    expect(maximumActiveWrites).toBe(1);

    firstWrite.release?.();
    await finish;
    await bridge.finish(recording);

    expect(writeCount).toBeGreaterThan(1);
    expect(maximumActiveWrites).toBe(1);
    expect(sink.close).toHaveBeenCalledTimes(1);
  });

  it("reports a rejected sink once and still closes once", async () => {
    const failure = new Error("sink unavailable");
    const sink: RecordingStreamSink = {
      write: vi.fn<(bytes: Uint8Array) => Promise<void>>().mockRejectedValue(failure),
      close: vi.fn<() => void>(),
      onError: vi.fn<(error: unknown) => void>(),
    };
    const recording = makeRecording();
    const bridge = new RecordingStreamBridge(sink);

    bridge.start(makeSession(recording));

    await expect(bridge.finish(recording)).rejects.toBe(failure);
    expect(sink.onError).toHaveBeenCalledTimes(1);
    expect(sink.onError).toHaveBeenCalledWith(failure);
    expect(sink.close).toHaveBeenCalledTimes(1);
  });
});

describe("createStreamingRecordingWriter", () => {
  it("carries raw workspace assets outside project snapshots", () => {
    const meta: RecordingStreamMeta = {
      version: 4,
      id: "asset-writer",
      name: "Asset writer",
      keyframeInterval: 120,
      createdAt: 1,
      duration: 10,
    };
    const descriptor = {
      kind: "asset" as const,
      assetId: "asset-payload",
      mimeType: "image/png",
      size: 4,
    };
    const writer = createStreamingRecordingWriter();
    writer.writeHeader(meta);
    writer.appendWorkspaceAssetSegment({
      descriptor,
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    const encoded = writer.finalize();

    expect(decodeRecordingStream(encoded).workspaceAssets).toEqual([
      { descriptor, bytes: new Uint8Array([1, 2, 3, 4]) },
    ]);

    const reader = createStreamingRecordingReader();
    reader.push(encoded);
    expect(reader.readDelta()?.newWorkspaceAssets).toEqual([
      { descriptor, bytes: new Uint8Array([1, 2, 3, 4]) },
    ]);
    expect(reader.getRecording()?.workspaceAssets).toBeUndefined();
  });

  it("releases drained chunks and finalizes without materializing stream history", () => {
    const meta: RecordingStreamMeta = {
      version: 4,
      id: "bounded-writer",
      name: "Bounded writer",
      keyframeInterval: 120,
      createdAt: 1,
      duration: 10,
    };
    const writer = createStreamingRecordingWriter();
    writer.writeHeader(meta);
    expect(writer.retainedByteLength()).toBeGreaterThan(0);
    expect(writer.drainPending().length).toBeGreaterThan(0);
    expect(writer.retainedByteLength()).toBe(0);

    for (let index = 0; index < 100; index += 1) {
      writer.appendEventSegment(SEGMENT_KIND.cursor, [
        { timestamp: index, x: index, y: index, visible: true },
      ]);
      expect(writer.drainPending().length).toBeGreaterThan(0);
      expect(writer.retainedByteLength()).toBe(0);
    }

    writer.appendFinalMetadata(meta);
    writer.finalizeStream();
    expect(writer.drainPending().length).toBeGreaterThan(0);
    expect(writer.retainedByteLength()).toBe(0);
    expect(() => writer.finalize()).toThrow(/already finalized/i);
  });
});

// Opt in explicitly because this is an acceptance/soak case, not a unit-test
// workload. It moves 100 MiB through the codec but keeps only one 1 MiB asset
// segment live at a time, so the assertion measures the reader's retained tail
// instead of relying on process-wide heap sampling.
describe.skipIf(process.env.NEXT_EDITOR_LARGE_RECORDING_TESTS !== "1")(
  "large streaming recording acceptance",
  () => {
    it("keeps compressed input capacity bounded across a 100 MiB stream", () => {
      const meta: RecordingStreamMeta = {
        version: 4,
        id: "large-bounded-reader",
        name: "Large bounded reader",
        keyframeInterval: 120,
        createdAt: 1,
        duration: 10,
      };
      const oneMiB = 1024 * 1024;
      const writer = createStreamingRecordingWriter();
      const reader = createStreamingRecordingReader();
      let streamedBytes = 0;
      let maximumCapacity = 0;

      const pushChunk = (chunk: Uint8Array) => {
        streamedBytes += chunk.byteLength;
        const split = Math.floor(chunk.byteLength / 2);
        reader.push(chunk.subarray(0, split));
        maximumCapacity = Math.max(maximumCapacity, reader.retainedCapacity());
        reader.push(chunk.subarray(split));
        maximumCapacity = Math.max(maximumCapacity, reader.retainedCapacity());
      };

      writer.writeHeader(meta);
      pushChunk(writer.drainPending());
      reader.readDelta();

      const assetBytes = new Uint8Array(oneMiB);
      for (let index = 0; index < 100; index += 1) {
        assetBytes.fill(index);
        writer.appendWorkspaceAssetSegment({
          descriptor: {
            kind: "asset",
            assetId: `large-asset-${index}`,
            mimeType: "application/octet-stream",
            size: assetBytes.byteLength,
          },
          bytes: assetBytes,
        });
        pushChunk(writer.drainPending());
        const delta = reader.readDelta();
        expect(delta?.newWorkspaceAssets).toHaveLength(1);
      }

      writer.appendFinalMetadata(meta);
      writer.finalizeStream();
      pushChunk(writer.drainPending());
      reader.readDelta();

      expect(streamedBytes).toBeGreaterThanOrEqual(100 * oneMiB);
      expect(reader.byteLength()).toBe(streamedBytes);
      expect(reader.retainedByteLength()).toBe(0);
      expect(maximumCapacity).toBeLessThanOrEqual(2 * oneMiB);
      expect(reader.isFinalized()).toBe(true);
    });
  },
);
