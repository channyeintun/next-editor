import { describe, expect, it } from "vitest";
import type { Recording } from "../core/src";
import { decodeBase64ToRecordings, encodeRecordingToBase64Stream } from "./recordingCodec";
import {
  createStreamingRecordingReader,
  decodeRecordingStream,
  encodeRecordingToStream,
} from "./streamingRecordingCodec";

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

    const [streamedCamera, oneShotCamera] = await Promise.all([
      readBlobAsArray(streamed.cameraBlob as Blob),
      readBlobAsArray(oneShot.cameraBlob as Blob),
    ]);
    expect(Array.from(streamedCamera)).toEqual(Array.from(oneShotCamera));
    expect(Array.from(streamedCamera)).toEqual([1, 2, 3]);
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
});
