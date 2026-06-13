import { describe, expect, it } from "vitest";
import type { Recording } from "../core/src";
import { decodeBase64ToRecordings, encodeRecordingsToBase64 } from "./recordingCodec";

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

    const encoded = await encodeRecordingsToBase64([recording]);
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
});
