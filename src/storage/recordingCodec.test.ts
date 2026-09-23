import { describe, expect, it } from "vitest";
import type { Recording } from "../core/src";
import {
  createContentDelta,
  createContentEditDelta,
  createFrameDelta,
  reconstructFrameAtIndex,
} from "../core/src/utils/frameDelta";
import { decompressBinaryToRecording } from "./recordingCodec";
import {
  createStreamingRecordingReader,
  createStreamingRecordingWriter,
  decodeRecordingStream,
  encodeRecordingToStream,
  SEGMENT_KIND,
} from "./streamingRecordingCodec";
import type { RecordingStreamMeta, StreamingRecordingDelta } from "./streamingRecordingCodec";
import {
  buildFooterChunk,
  buildHeaderChunk,
  buildSegmentChunk,
  encodeRecords,
  FLAG_HAS_AUDIO,
  FLAG_HAS_CAMERA,
  LEGACY_STREAM_FORMAT_VERSION,
  PREVIOUS_STREAM_FORMAT_VERSION,
  STREAM_FORMAT_VERSION,
} from "./streamingRecordingCodec/format";
import {
  flushPerformanceMetrics,
  resetPerformanceMetricsForTests,
} from "../utils/performanceMetrics";

function makeKeyframe(timestamp: number, content: string) {
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

function createRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    version: 4,
    id: "recording-1",
    name: "Round trip recording",
    createdAt: 1_700_000_000_000,
    duration: 1200,
    keyframeInterval: 120,
    frames: [
      {
        isKeyframe: true,
        timestamp: 0,
        state: {
          content: "console.log('hello');\n",
          position: {
            lineNumber: 1,
            column: 1,
          },
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

describe("recordingCodec", () => {
  it("round trips recording metadata and frames; audio bytes never embed in the stream", async () => {
    const audioBlob = new Blob([new Uint8Array([1, 2, 3, 4])], {
      type: "audio/webm",
    });
    const recording = createRecording({ audioBlob, audioSource: "external" });

    const encoded = await encodeRecordingToStream(recording);
    const decoded = await decompressBinaryToRecording(encoded);

    expect(decoded.id).toBe(recording.id);
    expect(decoded.version).toBe(4);
    // Audio metadata survives, but the bytes live outside the `.ne` (sibling file / IDB blob).
    expect(decoded.audioSource).toBe("external");
    expect(decoded.audioBlob).toBeUndefined();
    expect(decoded.frames).toEqual(recording.frames);
  });

  it("writes SCR format v4 and remains compatible with v2/v3 recordings", async () => {
    const recording = createRecording();
    const encoded = await encodeRecordingToStream(recording);
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    expect(view.getUint16(4, true)).toBe(STREAM_FORMAT_VERSION);

    for (const version of [PREVIOUS_STREAM_FORMAT_VERSION, LEGACY_STREAM_FORMAT_VERSION]) {
      const legacy = encoded.slice();
      new DataView(legacy.buffer).setUint16(4, version, true);
      expect(decodeRecordingStream(legacy).frames).toEqual(recording.frames);
    }
  });

  it("requires SCR format v3 for exact Monaco edit records", async () => {
    const base = "const value = 1;\n";
    const created = createContentEditDelta(base, {
      fileId: "/index.ts",
      path: "/index.ts",
      beforeVersion: 1,
      afterVersion: 2,
      beforeLength: base.length,
      afterLength: base.length,
      changes: [{ offset: base.indexOf("1"), deleteLength: 1, text: "2" }],
    });
    if (!created) throw new Error("Expected an exact content edit delta");

    const keyframe = makeKeyframe(0, base);
    const delta = createFrameDelta(keyframe, makeKeyframe(16, created.content), created);
    const encoded = await encodeRecordingToStream(
      createRecording({ duration: 16, frames: [keyframe, delta] }),
    );
    const legacy = encoded.slice();
    new DataView(legacy.buffer).setUint16(4, LEGACY_STREAM_FORMAT_VERSION, true);

    expect(() => decodeRecordingStream(legacy)).toThrow(/require format version 3/);
  });

  it("round trips a dmp content delta through the stream and reconstructs it", async () => {
    const base = makeKeyframe(0, "line one\nline two\nline three\nline four\n");
    // Two non-contiguous edits — the case the Myers delta is meant to keep compact.
    const next = makeKeyframe(500, "LINE one\nline two\nline three\nLINE four\n");
    const deltaFrame = createFrameDelta(base, next);
    expect(deltaFrame.contentDelta?.delta).toBeInstanceOf(Uint8Array);

    const recording = createRecording({ duration: 800, frames: [base, deltaFrame] });

    const encoded = await encodeRecordingToStream(recording);
    const decoded = await decompressBinaryToRecording(encoded);

    // The opaque delta must survive msgpack-bin + deflate byte-for-byte...
    expect(decoded.frames).toEqual(recording.frames);
    // ...and still reconstruct the edited content during replay.
    const reconstructed = reconstructFrameAtIndex(decoded.frames, 1);
    expect(reconstructed?.state.content).toBe("LINE one\nline two\nline three\nLINE four\n");
  });

  it("gives every decoded delta its own bytes instead of a view into the segment", async () => {
    const withPreview = (timestamp: number, content: string, html: string) => {
      const frame = makeKeyframe(timestamp, content);
      return {
        ...frame,
        state: { ...frame.state, previewState: { size: "medium" as const, content: html } },
      };
    };
    const first = withPreview(0, "line one\n".repeat(200), "<p>one</p>".repeat(200));
    const second = withPreview(
      16,
      "LINE one\n" + "line one\n".repeat(199),
      "<p>two</p>".repeat(200),
    );
    const frameDelta = createFrameDelta(first, second);
    const chatDelta = createContentDelta("", "Hello!");
    if (!chatDelta) throw new Error("Expected a chat content delta");
    const recording = createRecording({
      duration: 800,
      frames: [first, frameDelta],
      chatEvents: [{ timestamp: 5, event: { k: "content", delta: chatDelta } }],
    });

    const decoded = decodeRecordingStream(await encodeRecordingToStream(recording));
    const [, decodedDelta] = decoded.frames;
    const chatEvent = decoded.chatEvents?.[0].event;
    const views = [
      !decodedDelta.isKeyframe ? decodedDelta.contentDelta?.delta : undefined,
      !decodedDelta.isKeyframe &&
      decodedDelta.previewState &&
      "contentDelta" in decodedDelta.previewState
        ? decodedDelta.previewState.contentDelta.delta
        : undefined,
      chatEvent?.k === "content" ? chatEvent.delta.delta : undefined,
    ];

    for (const view of views) {
      expect(view).toBeInstanceOf(Uint8Array);
      // A view into the inflated segment would keep every byte of it alive.
      expect(view?.buffer.byteLength).toBe(view?.byteLength);
    }
    expect(decoded.frames).toEqual(recording.frames);
    expect(decoded.chatEvents).toEqual(recording.chatEvents);
  });

  it("round trips whiteboard events", async () => {
    const recording = createRecording({
      duration: 800,
      whiteboardEvents: [
        {
          timestamp: 10,
          upserts: [
            { id: "el-1", version: 1, versionNonce: 111, isDeleted: false, type: "freedraw" },
          ],
          isOpen: true,
        },
        {
          timestamp: 400,
          upserts: [
            { id: "el-1", version: 2, versionNonce: 222, isDeleted: false, type: "freedraw" },
          ],
          view: { scrollX: 10, scrollY: 20, zoom: 1.5 },
        },
        { timestamp: 600, removedIds: ["el-1"] },
      ],
    });

    const encoded = await encodeRecordingToStream(recording);
    const decoded = await decompressBinaryToRecording(encoded);

    expect(decoded.whiteboardEvents).toEqual(recording.whiteboardEvents);
    expect(decoded.tracks?.some((track) => track.kind === "whiteboard")).toBe(true);
  });

  it("round trips chat events (deltas + a checkpoint)", async () => {
    const contentDelta = createContentDelta("", "Hello!");
    expect(contentDelta).not.toBeNull();

    const recording = createRecording({
      duration: 800,
      chatEvents: [
        { timestamp: 0, event: { k: "draft", text: "Hello!" } },
        { timestamp: 1, event: { k: "draft", text: "" } },
        { timestamp: 2, event: { k: "message_start", id: "msg-1", role: "user" } },
        { timestamp: 5, event: { k: "content", delta: contentDelta! } },
        { timestamp: 20, event: { k: "message_start", id: "msg-2", role: "assistant" } },
        {
          timestamp: 30,
          event: {
            k: "tool_call",
            id: "tool-1",
            callId: "call-1",
            name: "read",
            arguments: '{"path":"src/App.tsx"}',
          },
        },
        {
          timestamp: 50,
          event: { k: "tool_result", callId: "call-1", output: "file contents" },
        },
        {
          timestamp: 60,
          event: {
            k: "checkpoint",
            state: {
              items: [{ kind: "message", id: "msg-1", role: "user", text: "Hello!" }],
              status: "streaming",
              draft: "",
            },
          },
        },
      ],
    });

    const encoded = await encodeRecordingToStream(recording);
    const decoded = await decompressBinaryToRecording(encoded);

    expect(decoded.chatEvents).toEqual(recording.chatEvents);
    expect(decoded.tracks?.some((track) => track.kind === "chat")).toBe(true);
  });

  it("decodes a recording without chatEvents (no format-version bump needed)", async () => {
    const recording = createRecording({ duration: 800 });

    const encoded = await encodeRecordingToStream(recording);
    const decoded = await decompressBinaryToRecording(encoded);

    expect(decoded.chatEvents).toBeUndefined();
  });

  it("incremental streaming reader matches a one-shot decode of the same bytes", async () => {
    const recording = createRecording({
      duration: 800,
      frames: [makeKeyframe(0, "a\n"), makeKeyframe(500, "ab\n")],
      cursorEvents: [
        { timestamp: 10, x: 1, y: 2, visible: true },
        { timestamp: 600, x: 3, y: 4, visible: true },
      ],
      audioBlob: new Blob([new Uint8Array([10, 20, 30, 40, 50])], { type: "audio/webm" }),
      audioSource: "external",
      cameraBlob: new Blob([new Uint8Array([1, 2, 3])], { type: "video/webm" }),
      cameraSource: "camera",
    });

    const bytes = await encodeRecordingToStream(recording);
    const oneShot = decodeRecordingStream(bytes);

    // Feed the bytes in tiny chunks so segment boundaries land mid-chunk.
    const reader = createStreamingRecordingReader();
    const CHUNK_SIZE = 13;
    const deltas: StreamingRecordingDelta[] = [];
    let releasedParsedInput = false;
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      reader.push(bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.length)));
      const delta = reader.readDelta();
      if (delta) deltas.push(delta);
      releasedParsedInput ||= reader.retainedByteLength() < reader.byteLength();
    }

    const streamed = reader.getRecording();
    expect(streamed).not.toBeNull();
    expect(reader.isFinalized()).toBe(true);
    if (!streamed) throw new Error("Expected a streamed recording");

    expect(streamed.frames).toEqual(oneShot.frames);
    expect(streamed.duration).toBe(oneShot.duration);
    expect(streamed.clusters).toEqual(oneShot.clusters);
    expect(streamed.tracks).toEqual(oneShot.tracks);
    expect(streamed.mediaFragments).toEqual(oneShot.mediaFragments);
    expect(streamed.cursorEvents).toEqual(oneShot.cursorEvents);
    expect(streamed.streamFinalized).toBe(true);
    expect(deltas.flatMap((delta) => delta.newFrames)).toEqual(oneShot.frames);
    expect(deltas.flatMap((delta) => delta.newCursorEvents)).toEqual(oneShot.cursorEvents);
    expect(deltas.map((delta) => delta.cursor)).toEqual(deltas.map((_, index) => index + 1));
    expect(reader.readDelta()).toBeNull();
    expect(reader.byteLength()).toBe(bytes.byteLength);
    expect(reader.retainedByteLength()).toBe(0);
    expect(reader.retainedCapacity()).toBeLessThanOrEqual(64 * 1024);
    expect(releasedParsedInput).toBe(true);

    // Media bytes are never embedded in the stream, so even though the recording had audio and
    // camera blobs, neither decode path reconstructs them — only the metadata survives.
    expect(streamed.audioBlob).toBeUndefined();
    expect(oneShot.audioBlob).toBeUndefined();
    expect(streamed.audioSource).toBe("external");
    expect(streamed.cameraBlob).toBeUndefined();
    expect(oneShot.cameraBlob).toBeUndefined();
    expect(streamed.cameraSource).toBe("camera");
  });

  it("progressive snapshots reuse already-normalized frames instead of re-cloning them", async () => {
    resetPerformanceMetricsForTests();
    // Regression guard for the long-recording CPU spike: frames are normalized once at
    // ingest, so successive getRecording() snapshots must hand back the *same* frame
    // objects (reference-equal), not fresh deep clones of the whole growing array.
    const recording = createRecording({
      duration: 800,
      frames: [makeKeyframe(0, "a\n"), makeKeyframe(500, "ab\n")],
    });
    const bytes = await encodeRecordingToStream(recording);

    const reader = createStreamingRecordingReader();
    // Withhold only the footer so every frame segment is decodable in the first snapshot.
    const footerHoldback = 16;
    reader.push(bytes.subarray(0, bytes.length - footerHoldback));
    const early = reader.getRecording();
    if (!early) throw new Error("Expected an early decoded snapshot");
    expect(early.frames.length).toBeGreaterThan(0);

    reader.push(bytes.subarray(bytes.length - footerHoldback));
    const late = reader.getRecording();
    if (!late) throw new Error("Expected a decoded recording");

    // Snapshot arrays are fresh (so consumers see growth), but their frame objects are not.
    expect(late.frames[0]).toBe(early.frames[0]);
    expect(late.frames).not.toBe(early.frames);
    const again = reader.getRecording();
    if (!again) throw new Error("Expected a repeat snapshot");
    expect(again.frames[0]).toBe(late.frames[0]);
    expect(again.frames).not.toBe(late.frames);
    expect(flushPerformanceMetrics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "recording.segment_encode" }),
        expect.objectContaining({ name: "recording.reader_push" }),
        expect.objectContaining({ name: "recording.reader_retained" }),
        expect.objectContaining({ name: "recording.reader_capacity" }),
        expect.objectContaining({ name: "recording.reader_snapshot", count: 3 }),
      ]),
    );
  });

  it("progressive snapshots do not share mutable event arrays", async () => {
    // Event accumulator arrays must be copied per snapshot, not shared by reference.
    // If a snapshot's event arrays are shared, later push() calls that mutate them
    // will silently grow the previously-returned snapshot, breaking consumers that
    // key memoization on array reference (like React Compiler).
    const recording = createRecording({
      duration: 800,
      frames: [makeKeyframe(0, "a\n"), makeKeyframe(500, "ab\n")],
      cursorEvents: [
        { timestamp: 10, x: 1, y: 2, visible: true },
        { timestamp: 250, x: 2, y: 3, visible: true },
        { timestamp: 600, x: 3, y: 4, visible: true },
      ],
      slideEvents: [
        { timestamp: 50, type: "slide_open", slideId: "slide-1" },
        { timestamp: 550, type: "slide_change", slideId: "slide-2" },
      ],
    });

    const bytes = await encodeRecordingToStream(recording);

    const reader = createStreamingRecordingReader();
    // Feed in small chunks like the neighboring test does, withholding the footer to force
    // a mid-stream snapshot that doesn't yet have all events.
    const CHUNK_SIZE = 40;
    const footerHoldback = 16;
    const partialLength = bytes.length - footerHoldback;

    for (let offset = 0; offset < partialLength; offset += CHUNK_SIZE) {
      reader.push(bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, partialLength)));
    }

    const snapshot1 = reader.getRecording();
    if (!snapshot1) throw new Error("Expected a snapshot before footer");

    const snapshot1CursorLength = snapshot1.cursorEvents?.length ?? 0;
    const snapshot1SlideLength = snapshot1.slideEvents?.length ?? 0;

    // With the footer withheld, we should have partial events (not all 3 cursor or both slides).
    expect(snapshot1CursorLength).toBeGreaterThan(0);
    expect(snapshot1CursorLength).toBeLessThanOrEqual(3);
    expect(snapshot1SlideLength).toBeGreaterThan(0);
    expect(snapshot1SlideLength).toBeLessThanOrEqual(2);

    // Push the footer to complete the stream.
    reader.push(bytes.subarray(partialLength));

    const snapshot2 = reader.getRecording();
    if (!snapshot2) throw new Error("Expected a snapshot after footer");

    // Snapshot 1's event arrays must not have grown (they must be independent copies).
    expect(snapshot1.cursorEvents?.length).toBe(snapshot1CursorLength);
    expect(snapshot1.slideEvents?.length).toBe(snapshot1SlideLength);

    // Snapshot 2 should have all events (the stream completed).
    expect(snapshot2.cursorEvents?.length).toBe(3);
    expect(snapshot2.slideEvents?.length).toBe(2);

    // The snapshots must have different array references (not shared).
    expect(snapshot1.cursorEvents).not.toBe(snapshot2.cursorEvents);
    expect(snapshot1.slideEvents).not.toBe(snapshot2.slideEvents);
  });

  it("progressive snapshots keep the cluster bounds they were handed", () => {
    // When the header carries no cluster table, clusters come from the
    // per-segment summaries, which later segments widen in place. A snapshot handed out
    // before that must keep its own copy.
    const writer = createStreamingRecordingWriter();
    writer.writeHeader({
      version: 4,
      id: "live-clusters",
      name: "Live clusters",
      keyframeInterval: 120,
      createdAt: 1,
      duration: 0,
    });
    const reader = createStreamingRecordingReader();
    writer.appendEventSegment(
      SEGMENT_KIND.cursor,
      [{ timestamp: 100, x: 1, y: 1, visible: true }],
      {
        clusterIndex: 0,
      },
    );
    reader.push(writer.drainPending());
    const early = reader.getRecording();
    expect(early?.clusters).toEqual([
      { index: 0, startTimeMs: 100, endTimeMs: 100, containsKeyframe: false },
    ]);

    writer.appendEventSegment(
      SEGMENT_KIND.cursor,
      [{ timestamp: 900, x: 2, y: 2, visible: true }],
      {
        clusterIndex: 0,
      },
    );
    reader.push(writer.drainPending());

    expect(reader.getRecording()?.clusters?.[0].endTimeMs).toBe(900);
    expect(early?.clusters?.[0].endTimeMs).toBe(100);
  });

  it("decodes a segment holding more records than fit in one call's arguments", async () => {
    // A stretch with no editor change is one cluster, so all of its cursor samples
    // (one per pointer event) share a segment: 200,000 is about 28 minutes at 120 Hz.
    // That takes about half a second to encode and decode on an idle machine, so the
    // default 5 s timeout is too tight when the suite runs beside other work.
    const cursorEvents = Array.from({ length: 200_000 }, (_, index) => ({
      timestamp: index,
      x: index % 800,
      y: index % 600,
      visible: true,
    }));
    const bytes = await encodeRecordingToStream(
      createRecording({ duration: 200_000, frames: [makeKeyframe(0, "a\n")], cursorEvents }),
    );

    expect(decodeRecordingStream(bytes).cursorEvents).toHaveLength(200_000);
    const reader = createStreamingRecordingReader();
    reader.push(bytes);
    expect(reader.getRecording()?.cursorEvents).toHaveLength(200_000);
  }, 30_000);

  it("round trips a preview snapshot of a deeply nested page", async () => {
    // rrweb serializes the DOM as nested childNodes, two MessagePack levels per DOM
    // level, so a page 60 elements deep sits well past msgpack's default depth of 100.
    let nextId = 1;
    const element = (depth: number): Record<string, unknown> => ({
      type: 2,
      tagName: "div",
      attributes: { class: "wrapper" },
      childNodes: depth > 1 ? [element(depth - 1)] : [{ type: 3, textContent: "leaf", id: 0 }],
      id: nextId++,
    });
    const recording = createRecording({
      previewInitialDocuments: [
        {
          version: 1,
          time: 0,
          documentId: "deep",
          events: [{ type: 2, timestamp: 0, data: { node: element(60) } }],
        },
      ],
    });

    const decoded = decodeRecordingStream(await encodeRecordingToStream(recording));

    expect(decoded.previewInitialDocuments).toEqual(recording.previewInitialDocuments);
  });

  it("refuses to save a workspace snapshot larger than a header may hold", async () => {
    // The header carries the recorded project's text; a reader stops inflating it at 8 MiB.
    const content = "export const value = 42;\n".repeat(400_000); // ~9.5 MiB
    const recording = createRecording({
      workspaceSnapshot: {
        activeFilePath: "data.ts",
        project: {
          id: "big",
          name: "Big",
          lessonType: "react",
          entryFilePath: "data.ts",
          folders: [],
          files: {
            "data.ts": { path: "data.ts", name: "data.ts", language: "typescript", content },
          },
        },
      },
    });

    await expect(encodeRecordingToStream(recording)).rejects.toThrow(
      /Recording is too large to save: its metadata/,
    );
  });

  it("decodes a replayable prefix before the footer arrives, then finalizes", async () => {
    const recording = createRecording({
      duration: 800,
      frames: [makeKeyframe(0, "a\n"), makeKeyframe(500, "ab\n")],
    });
    const bytes = await encodeRecordingToStream(recording);

    const reader = createStreamingRecordingReader();
    // Withhold the trailing footer bytes — the prefix must still decode.
    const footerHoldback = 16;
    reader.push(bytes.subarray(0, bytes.length - footerHoldback));

    const partial = reader.getRecording();
    expect(partial).not.toBeNull();
    expect(reader.isFinalized()).toBe(false);
    if (!partial) throw new Error("Expected a partial recording");
    expect(partial.streamFinalized).toBe(false);
    expect(partial.frames.length).toBeGreaterThan(0);

    // The completing footer flips the stream to finalized without re-decoding.
    reader.push(bytes.subarray(bytes.length - footerHoldback));
    expect(reader.isFinalized()).toBe(true);
    expect(reader.getRecording()?.streamFinalized).toBe(true);
  });

  it("decodes every prefix of a stream in one shot, including one cut inside the footer", async () => {
    const recording = createRecording({
      duration: 800,
      frames: [makeKeyframe(0, "a\n"), makeKeyframe(500, "ab\n")],
      cursorEvents: [
        { timestamp: 10, x: 1, y: 2, visible: true },
        { timestamp: 600, x: 3, y: 4, visible: true },
      ],
    });
    const bytes = await encodeRecordingToStream(recording);
    const complete = decodeRecordingStream(bytes);
    const headerEnd = 12 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);

    // The footer opens with the segment count and the first index entry, which read as a
    // segment header of a known kind; a prefix ending inside it must still decode.
    for (let length = headerEnd; length < bytes.length; length += 1) {
      const prefix = decodeRecordingStream(bytes.subarray(0, length));
      expect(prefix.streamFinalized).toBe(false);
      expect(complete.frames.slice(0, prefix.frames.length)).toEqual(prefix.frames);
    }
    expect(complete.streamFinalized).toBe(true);
  });

  it("rejects a finalized stream whose segments do not end at the footer", async () => {
    const recording = createRecording({
      duration: 800,
      frames: [makeKeyframe(0, "a\n"), makeKeyframe(500, "ab\n")],
      cursorEvents: [
        { timestamp: 10, x: 1, y: 2, visible: true },
        { timestamp: 600, x: 3, y: 4, visible: true },
      ],
    });
    const bytes = await encodeRecordingToStream(recording);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Corrupt the second segment's u32 byteLength so it runs past the footer.
    const firstSegment = 12 + view.getUint32(8, true);
    const secondSegment = firstSegment + 22 + view.getUint32(firstSegment + 1, true);
    view.setUint32(secondSegment + 1, 100_000, true);

    expect(() => decodeRecordingStream(bytes)).toThrow(/malformed segment tail before footer/);
    const reader = createStreamingRecordingReader();
    expect(() => reader.push(bytes)).toThrow(/malformed segment tail before footer/);
  });

  it("does not take a .ne file carried as a workspace asset for the stream's footer", async () => {
    // Asset segments hold raw file bytes, so a prefix that ends with an asset which is
    // itself a finalized .ne ends in bytes that pass every footer check.
    const embedded = await encodeRecordingToStream(createRecording({ id: "embedded" }));
    const writer = createStreamingRecordingWriter();
    writer.writeHeader({
      version: 4,
      id: "outer",
      name: "Outer",
      keyframeInterval: 120,
      createdAt: 1,
      duration: 0,
    });
    const chunks = [writer.drainPending()];
    writer.appendWorkspaceAssetSegment({
      descriptor: {
        kind: "asset",
        assetId: "sha256-embedded",
        mimeType: "application/octet-stream",
        size: embedded.byteLength,
      },
      bytes: embedded,
    });
    chunks.push(writer.drainPending());
    writer.appendFrameSegment([makeKeyframe(0, "a\n")]);
    writer.appendFrameSegment([makeKeyframe(500, "ab\n")]);
    writer.finalizeStream();
    chunks.push(writer.drainPending());

    const prefix = new Uint8Array(chunks[0].byteLength + chunks[1].byteLength);
    prefix.set(chunks[0]);
    prefix.set(chunks[1], chunks[0].byteLength);
    const decodedPrefix = decodeRecordingStream(prefix);
    expect(decodedPrefix.streamFinalized).toBe(false);
    expect(decodedPrefix.workspaceAssets?.[0].bytes).toEqual(embedded);

    const reader = createStreamingRecordingReader();
    for (const chunk of chunks) reader.push(chunk);
    const streamed = reader.getRecording();
    expect(reader.isFinalized()).toBe(true);
    expect(streamed?.frames).toHaveLength(2);
    expect(streamed?.workspaceAssets).toHaveLength(1);
  });

  it("skips a segment kind it does not know once the footer confirms the stream", () => {
    // A newer writer's kind (12+), between a frame segment and a cursor segment.
    const header = buildHeaderChunk(
      {
        version: 4,
        id: "future",
        name: "Future",
        keyframeInterval: 120,
        createdAt: 1,
        duration: 100,
      },
      0,
    );
    const segments = [
      buildSegmentChunk(0, encodeRecords([makeKeyframe(0, "a\n")]).payload, 0, 10, 0, 0, true),
      buildSegmentChunk(12, new Uint8Array([1, 2, 3, 4, 5]), 10, 10, -1, 0, false),
      buildSegmentChunk(
        7,
        encodeRecords([{ timestamp: 20, x: 1, y: 1, visible: true }]).payload,
        20,
        20,
        -1,
        0,
        false,
      ),
    ];
    let byteOffset = header.byteLength;
    const index = segments.map((segment) => {
      const entry = { kind: segment[0], byteOffset, firstTimestampMs: 0, firstFrameIndex: -1 };
      byteOffset += segment.byteLength;
      return entry;
    });
    const concat = (parts: Uint8Array[]) => {
      const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      return bytes;
    };
    // The footer counts the skipped segment too.
    const bytes = concat([header, ...segments, buildFooterChunk(index)]);

    const oneShot = decodeRecordingStream(bytes);
    expect(oneShot.streamFinalized).toBe(true);
    expect(oneShot.frames).toHaveLength(1);
    expect(oneShot.cursorEvents).toHaveLength(1);
    for (const chunkSize of [1, 7, 64, bytes.length]) {
      const reader = createStreamingRecordingReader();
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        reader.push(bytes.subarray(offset, offset + chunkSize));
      }
      expect(reader.isFinalized()).toBe(true);
      expect(reader.getRecording()?.cursorEvents).toHaveLength(1);
    }

    // Without the footer the unknown kind could be the footer's first bytes, so both
    // decoders stop there: the cursor segment after it waits for the footer.
    const livePrefix = concat([header, ...segments]);
    expect(decodeRecordingStream(livePrefix).cursorEvents).toBeUndefined();
    const reader = createStreamingRecordingReader();
    reader.push(livePrefix);
    expect(reader.getRecording()?.frames).toHaveLength(1);
    expect(reader.getRecording()?.cursorEvents).toBeUndefined();
  });

  it("skips a retired kind-10 segment and keeps the header's metadata", () => {
    // Kind 10 once carried final metadata from a live writer that never shipped; no
    // file holds one. A reader must neither stop at it nor let it replace the header.
    const header = buildHeaderChunk(
      {
        version: 4,
        id: "header-id",
        name: "Header",
        keyframeInterval: 120,
        createdAt: 1,
        duration: 100,
      },
      0,
    );
    const retiredMeta = {
      version: 4,
      id: "retired-id",
      name: "Retired",
      keyframeInterval: 120,
      createdAt: 1,
      duration: 9_000,
    };
    const segments = [
      buildSegmentChunk(0, encodeRecords([makeKeyframe(0, "a\n")]).payload, 0, 10, 0, 0, true),
      buildSegmentChunk(10, encodeRecords([retiredMeta]).payload, 10, 10, -1, 0, false),
      buildSegmentChunk(
        7,
        encodeRecords([{ timestamp: 20, x: 1, y: 1, visible: true }]).payload,
        20,
        20,
        -1,
        0,
        false,
      ),
    ];
    let byteOffset = header.byteLength;
    const index = segments.map((segment) => {
      const entry = { kind: segment[0], byteOffset, firstTimestampMs: 0, firstFrameIndex: -1 };
      byteOffset += segment.byteLength;
      return entry;
    });
    const concat = (parts: Uint8Array[]) => {
      const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      return bytes;
    };

    for (const bytes of [
      concat([header, ...segments, buildFooterChunk(index)]),
      concat([header, ...segments]),
    ]) {
      const oneShot = decodeRecordingStream(bytes);
      expect(oneShot.id).toBe("header-id");
      expect(oneShot.duration).toBe(100);
      expect(oneShot.cursorEvents).toHaveLength(1);
      const reader = createStreamingRecordingReader();
      reader.push(bytes);
      expect(reader.getRecording()?.id).toBe("header-id");
      expect(reader.getRecording()?.cursorEvents).toHaveLength(1);
    }
  });

  it("rejects bytes that are not an SCR3 stream", async () => {
    await expect(decompressBinaryToRecording(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow(
      /SCR3/,
    );
  });

  it("rejects a header whose metadata is not a recording's", () => {
    const valid = {
      version: 4 as const,
      id: "header",
      name: "Header",
      keyframeInterval: 120,
      createdAt: 1,
      duration: 10,
    };
    for (const meta of [{}, null, { ...valid, duration: "10" }, { ...valid, clusters: "abc" }]) {
      const header = buildHeaderChunk(meta as never, 0);
      expect(() => decodeRecordingStream(header)).toThrow(
        "Invalid SCR3 stream: malformed header metadata",
      );
      expect(() => createStreamingRecordingReader().push(header)).toThrow(
        "Invalid SCR3 stream: malformed header metadata",
      );
    }
    expect(decodeRecordingStream(buildHeaderChunk(valid, 0)).id).toBe("header");
  });

  it("rejects a stream too short to hold its header prefix", () => {
    const magicAndVersion = new Uint8Array([0x53, 0x43, 0x52, 0x33, 4, 0]);
    expect(() => decodeRecordingStream(magicAndVersion)).toThrow(
      "Invalid SCR3 stream: truncated header",
    );
  });

  it("externalizes camera as a sibling reference instead of inline chunks", async () => {
    // A recording whose camera lives in its own file carries only a `cameraFile` reference (no
    // cameraBlob). The stream must still advertise a camera track but embed no camera bytes.
    const recording = createRecording({
      duration: 800,
      frames: [makeKeyframe(0, "a\n"), makeKeyframe(500, "ab\n")],
      cameraFile: "recording-1.webm",
      cameraSource: "camera",
      cameraStartOffsetMs: 120,
    });

    const bytes = await encodeRecordingToStream(recording);

    // Header still advertises a camera track via FLAG_HAS_CAMERA (flags u16 at byte offset 6)...
    const flags = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(6, true);
    expect(flags & FLAG_HAS_CAMERA).toBeTruthy();

    const decoded = decodeRecordingStream(bytes);
    expect(decoded.cameraFile).toBe("recording-1.webm");
    expect(decoded.cameraSource).toBe("camera");
    expect(decoded.cameraStartOffsetMs).toBe(120);
    // ...but no camera bytes were embedded, so there is no reassembled blob.
    expect(decoded.cameraBlob).toBeUndefined();
  });

  it("round trips captions through SCR3 encode/decode", async () => {
    const recording = createRecording({
      captions: [
        {
          id: "en-track",
          language: "en",
          label: "English",
          default: true,
          cues: [
            { start: 0, end: 2000, text: "Hello world" },
            { start: 2500, end: 5000, text: "This is a test" },
          ],
        },
        {
          id: "es-track",
          language: "es",
          label: "Spanish (español)",
          cues: [
            { start: 0, end: 2000, text: "Hola mundo" },
            { start: 2500, end: 5000, text: "Esto es una prueba" },
          ],
        },
      ],
    });

    const bytes = await encodeRecordingToStream(recording);
    const decoded = decodeRecordingStream(bytes);

    expect(decoded.captions).toEqual(recording.captions);
  });

  it("round trips captions with word-level timing through SCR3", async () => {
    const recording = createRecording({
      captions: [
        {
          id: "en-words",
          language: "en",
          cues: [
            {
              start: 0,
              end: 2000,
              text: "Hello world",
              words: [
                { start: 0, end: 900, text: "Hello" },
                { start: 1000, end: 2000, text: "world" },
              ],
            },
          ],
        },
      ],
    });

    const encoded = await encodeRecordingToStream(recording);
    const decoded = await decompressBinaryToRecording(encoded);

    expect(decoded.captions).toEqual(recording.captions);
  });

  it("round trips a recording without captions", async () => {
    const recording = createRecording();

    const bytes = await encodeRecordingToStream(recording);
    const decoded = decodeRecordingStream(bytes);

    expect(decoded.captions).toBeUndefined();
  });

  it("externalizes audio as a sibling reference instead of inline chunks", async () => {
    // A recording whose audio lives in its own file carries only an `audioFile` reference. The
    // stream must still advertise an audio track but embed no audio bytes — this is what keeps
    // long recordings' `.ne` files small.
    const recording = createRecording({
      duration: 800,
      frames: [makeKeyframe(0, "a\n"), makeKeyframe(500, "ab\n")],
      audioFile: "recording-1.weba",
      audioSource: "microphone",
      audioStartOffsetMs: 150,
    });

    const bytes = await encodeRecordingToStream(recording);

    // Header still advertises an audio track via FLAG_HAS_AUDIO (flags u16 at byte offset 6)...
    const flags = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(6, true);
    expect(flags & FLAG_HAS_AUDIO).toBeTruthy();

    const decoded = decodeRecordingStream(bytes);
    expect(decoded.audioFile).toBe("recording-1.weba");
    expect(decoded.audioSource).toBe("microphone");
    expect(decoded.audioStartOffsetMs).toBe(150);
    expect(decoded.tracks?.some((track) => track.kind === "audio")).toBe(true);
    // ...but no audio bytes were embedded, so there is no reassembled blob.
    expect(decoded.audioBlob).toBeUndefined();
    expect(decoded.mediaFragments?.some((fragment) => fragment.trackId === "audio")).toBeFalsy();
  });

  it("does not embed audio bytes when a recording carries both a blob and an audioFile", async () => {
    // Export sets `audioFile` and drops the blob, but the encoder must be safe against a caller
    // passing both: the external reference wins and no inline chunks are written.
    const recording = createRecording({
      audioBlob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" }),
      audioFile: "recording-1.weba",
      audioSource: "microphone",
    });

    const bytes = await encodeRecordingToStream(recording);
    const decoded = decodeRecordingStream(bytes);

    expect(decoded.audioFile).toBe("recording-1.weba");
    expect(decoded.audioBlob).toBeUndefined();
  });

  it("round trips an externalized audio reference through the .ne path", async () => {
    const recording = createRecording({
      audioFile: "my-recording.weba",
      audioUrl: "https://example.com/my-recording.weba",
      audioSource: "external",
      audioStartOffsetMs: 40,
    });

    const encoded = await encodeRecordingToStream(recording);
    const decoded = await decompressBinaryToRecording(encoded);

    expect(decoded.audioFile).toBe("my-recording.weba");
    expect(decoded.audioUrl).toBe("https://example.com/my-recording.weba");
    expect(decoded.audioStartOffsetMs).toBe(40);
    expect(decoded.audioBlob).toBeUndefined();
  });

  it("round trips an externalized camera through the .ne path", async () => {
    const recording = createRecording({
      cameraFile: "my-recording.webm",
      cameraSource: "camera",
      cameraStartOffsetMs: 80,
    });

    const encoded = await encodeRecordingToStream(recording);
    const decoded = await decompressBinaryToRecording(encoded);

    expect(decoded.cameraFile).toBe("my-recording.webm");
    expect(decoded.cameraStartOffsetMs).toBe(80);
    expect(decoded.cameraBlob).toBeUndefined();
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
