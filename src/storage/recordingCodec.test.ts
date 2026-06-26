import { describe, expect, it } from "vitest";
import type { Recording } from "../core/src";
import { decodeBase64 } from "../core/src/utils/base64";
import { createFrameDelta, reconstructFrameAtIndex } from "../core/src/utils/frameDelta";
import { decodeBase64ToRecordings, encodeRecordingToBase64Stream } from "./recordingCodec";
import {
  createStreamingRecordingReader,
  decodeRecordingStream,
  encodeRecordingToStream,
} from "./streamingRecordingCodec";
import { FLAG_HAS_CAMERA } from "./streamingRecordingCodec/format";

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

function readBlobAsArray(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result));
        return;
      }

      reject(new Error("Expected Blob to read as an ArrayBuffer"));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read Blob"));
    };
    reader.readAsArrayBuffer(blob);
  });
}

function createRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    version: 3,
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
  it("round trips recording metadata, frames, and audio payloads", async () => {
    const audioBlob = new Blob([new Uint8Array([1, 2, 3, 4])], {
      type: "audio/webm",
    });
    const recording = createRecording({ audioBlob, audioSource: "external" });

    const encoded = await encodeRecordingToBase64Stream(recording);
    const [decoded] = await decodeBase64ToRecordings(encoded);

    expect(decoded.id).toBe(recording.id);
    expect(decoded.version).toBe(3);
    expect(decoded.audioSource).toBe("external");
    expect(decoded.frames).toEqual(recording.frames);
    const decodedAudioBlob = decoded.audioBlob;
    expect(decodedAudioBlob).toBeInstanceOf(Blob);

    if (!(decodedAudioBlob instanceof Blob)) {
      throw new Error("Expected decoded audio payload to be a Blob");
    }

    expect(decodedAudioBlob.type).toBe("audio/webm");

    const decodedAudio = await readBlobAsArray(decodedAudioBlob);
    expect(Array.from(decodedAudio)).toEqual([1, 2, 3, 4]);
  });

  it("round trips a go-diff content delta through the zstd stream and reconstructs it", async () => {
    const base = makeKeyframe(0, "line one\nline two\nline three\nline four\n");
    // Two non-contiguous edits — the case the go-diff delta is meant to keep compact.
    const next = makeKeyframe(500, "LINE one\nline two\nline three\nLINE four\n");
    const deltaFrame = createFrameDelta(base, next);
    expect(deltaFrame.contentDelta?.delta).toBeInstanceOf(Uint8Array);

    const recording = createRecording({ duration: 800, frames: [base, deltaFrame] });

    const encoded = await encodeRecordingToBase64Stream(recording);
    const [decoded] = await decodeBase64ToRecordings(encoded);

    // The opaque delta must survive msgpack-bin + zstd byte-for-byte...
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

    const [streamedAudio, oneShotAudio] = await Promise.all([
      readBlobAsArray(streamed.audioBlob as Blob),
      readBlobAsArray(oneShot.audioBlob as Blob),
    ]);
    expect(Array.from(streamedAudio)).toEqual(Array.from(oneShotAudio));
    expect(Array.from(streamedAudio)).toEqual([10, 20, 30, 40, 50]);

    // Camera video is never embedded in the stream, so even though the recording had a camera
    // blob, neither decode path reconstructs one — only the camera metadata survives.
    expect(streamed.cameraBlob).toBeUndefined();
    expect(oneShot.cameraBlob).toBeUndefined();
    expect(streamed.cameraSource).toBe("camera");
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

  it("exposes audio that grows fragment-by-fragment as the stream arrives", async () => {
    // Three audio fragments across three clusters simulate MediaRecorder timeslices.
    const audioChunks = [
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([5, 6, 7, 8]),
      new Uint8Array([9, 10, 11, 12]),
    ];
    const recording = createRecording({
      duration: 1200,
      keyframeInterval: 120,
      frames: [makeKeyframe(0, "a\n"), makeKeyframe(400, "ab\n"), makeKeyframe(800, "abc\n")],
      audioSource: "microphone",
      audioBlob: new Blob(audioChunks, { type: "audio/webm" }),
      tracks: [
        { id: "editor", kind: "editor", durationMs: 1200 },
        {
          id: "audio",
          kind: "audio",
          mimeType: "audio/webm",
          source: "microphone",
          startOffsetMs: 0,
          durationMs: 1200,
        },
      ],
      clusters: [
        { index: 0, startTimeMs: 0, endTimeMs: 400, containsKeyframe: true },
        { index: 1, startTimeMs: 400, endTimeMs: 800, containsKeyframe: true },
        { index: 2, startTimeMs: 800, endTimeMs: 1200, containsKeyframe: true },
      ],
      mediaFragments: [
        {
          trackId: "audio",
          clusterIndex: 0,
          startTimeMs: 0,
          endTimeMs: 400,
          bytes: audioChunks[0],
          isInit: true,
        },
        {
          trackId: "audio",
          clusterIndex: 1,
          startTimeMs: 400,
          endTimeMs: 800,
          bytes: audioChunks[1],
        },
        {
          trackId: "audio",
          clusterIndex: 2,
          startTimeMs: 800,
          endTimeMs: 1200,
          bytes: audioChunks[2],
        },
      ],
    });

    const bytes = await encodeRecordingToStream(recording);

    // Feed one byte at a time and record each new audio "loaded edge" — the value the
    // player uses (`getPlaybackAudioState` → `loadedUntilMs`) to gate streamed playback.
    const reader = createStreamingRecordingReader();
    const loadedEdges: number[] = [];
    let audioFragmentCount = 0;
    for (let offset = 0; offset < bytes.length; offset += 1) {
      reader.push(bytes.subarray(offset, offset + 1));
      const audioFragments =
        reader.getRecording()?.mediaFragments?.filter((fragment) => fragment.trackId === "audio") ??
        [];
      if (audioFragments.length !== audioFragmentCount) {
        audioFragmentCount = audioFragments.length;
        loadedEdges.push(audioFragments.reduce((edge, f) => Math.max(edge, f.endTimeMs), 0));
      }
    }

    // The loaded edge advances monotonically, one step per fragment, well before the
    // whole file (or its footer) has arrived — i.e. audio is progressively playable.
    expect(loadedEdges).toEqual([400, 800, 1200]);
    expect(reader.isFinalized()).toBe(true);

    const audioBlob = reader.getRecording()?.audioBlob as Blob;
    const audioBytes = await readBlobAsArray(audioBlob);
    expect(Array.from(audioBytes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("streams a base64-wrapped recording fed as aligned groups (the .ne text path)", async () => {
    // The shipped `.ne` files are base64-wrapped SCR3 streams, so the loader decodes whole
    // 4-char base64 groups into bytes and pushes them to the same incremental reader. This
    // mirrors that path and asserts it reconstructs the recording identically.
    const recording = createRecording({
      duration: 800,
      frames: [makeKeyframe(0, "a\n"), makeKeyframe(500, "ab\n")],
      audioSource: "external",
      audioBlob: new Blob([new Uint8Array([7, 8, 9])], { type: "audio/webm" }),
    });

    const base64 = await encodeRecordingToBase64Stream(recording);
    const oneShot = (await decodeBase64ToRecordings(base64))[0];

    const reader = createStreamingRecordingReader();
    let cleanBase64 = "";
    let decoded = 0;
    const feed = () => {
      const boundary = cleanBase64.length - (cleanBase64.length % 4);
      if (boundary <= decoded) return;
      const bytes = decodeBase64(cleanBase64.slice(decoded, boundary));
      decoded = boundary;
      if (bytes.length > 0) reader.push(bytes);
    };

    // Network slices of 7 chars (not a multiple of 4) stress the group alignment.
    const SLICE = 7;
    for (let offset = 0; offset < base64.length; offset += SLICE) {
      cleanBase64 += base64.slice(offset, offset + SLICE).replace(/\s/g, "");
      feed();
    }
    feed(); // final (padded) group

    const streamed = reader.getRecording();
    expect(streamed).not.toBeNull();
    expect(reader.isFinalized()).toBe(true);
    if (!streamed) throw new Error("Expected a streamed recording");

    expect(streamed.frames).toEqual(oneShot.frames);
    expect(streamed.duration).toBe(oneShot.duration);
    expect(streamed.streamFinalized).toBe(true);

    const audioBytes = await readBlobAsArray(streamed.audioBlob as Blob);
    expect(Array.from(audioBytes)).toEqual([7, 8, 9]);
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

    const encoded = await encodeRecordingToBase64Stream(recording);
    const [decoded] = await decodeBase64ToRecordings(encoded);

    expect(decoded.captions).toEqual(recording.captions);
  });

  it("round trips a recording without captions (backwards compat)", async () => {
    const recording = createRecording();

    const bytes = await encodeRecordingToStream(recording);
    const decoded = decodeRecordingStream(bytes);

    expect(decoded.captions).toBeUndefined();
  });

  it("round trips an externalized camera through the base64 .ne path", async () => {
    const recording = createRecording({
      cameraFile: "my-recording.webm",
      cameraSource: "camera",
      cameraStartOffsetMs: 80,
    });

    const encoded = await encodeRecordingToBase64Stream(recording);
    const [decoded] = await decodeBase64ToRecordings(encoded);

    expect(decoded.cameraFile).toBe("my-recording.webm");
    expect(decoded.cameraStartOffsetMs).toBe(80);
    expect(decoded.cameraBlob).toBeUndefined();
  });
});
