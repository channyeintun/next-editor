import { describe, expect, it } from "vitest";
import type { Recording } from "../core/src";
import { createFrameDelta, reconstructFrameAtIndex } from "../core/src/utils/frameDelta";
import { decompressBinaryToRecordings } from "./recordingCodec";
import {
  createStreamingRecordingReader,
  decodeRecordingStream,
  encodeRecordingToStream,
} from "./streamingRecordingCodec";
import { FLAG_HAS_AUDIO, FLAG_HAS_CAMERA } from "./streamingRecordingCodec/format";

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
    const [decoded] = await decompressBinaryToRecordings(encoded);

    expect(decoded.id).toBe(recording.id);
    expect(decoded.version).toBe(4);
    // Audio metadata survives, but the bytes live outside the `.ne` (sibling file / IDB blob).
    expect(decoded.audioSource).toBe("external");
    expect(decoded.audioBlob).toBeUndefined();
    expect(decoded.frames).toEqual(recording.frames);
  });

  it("round trips a dmp content delta through the stream and reconstructs it", async () => {
    const base = makeKeyframe(0, "line one\nline two\nline three\nline four\n");
    // Two non-contiguous edits — the case the Myers delta is meant to keep compact.
    const next = makeKeyframe(500, "LINE one\nline two\nline three\nLINE four\n");
    const deltaFrame = createFrameDelta(base, next);
    expect(deltaFrame.contentDelta?.delta).toBeInstanceOf(Uint8Array);

    const recording = createRecording({ duration: 800, frames: [base, deltaFrame] });

    const encoded = await encodeRecordingToStream(recording);
    const [decoded] = await decompressBinaryToRecordings(encoded);

    // The opaque delta must survive msgpack-bin + deflate byte-for-byte...
    expect(decoded.frames).toEqual(recording.frames);
    // ...and still reconstruct the edited content during replay.
    const reconstructed = reconstructFrameAtIndex(decoded.frames, 1);
    expect(reconstructed?.state.content).toBe("LINE one\nline two\nline three\nLINE four\n");
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
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      reader.push(bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.length)));
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

  it("rejects bytes that are not an SCR3 stream", async () => {
    await expect(decompressBinaryToRecordings(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow(
      /SCR3/,
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
    const [decoded] = await decompressBinaryToRecordings(encoded);

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
    const [decoded] = await decompressBinaryToRecordings(encoded);

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
    const [decoded] = await decompressBinaryToRecordings(encoded);

    expect(decoded.cameraFile).toBe("my-recording.webm");
    expect(decoded.cameraStartOffsetMs).toBe(80);
    expect(decoded.cameraBlob).toBeUndefined();
  });
});
