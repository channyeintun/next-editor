import { describe, expect, it, vi } from "vitest";
import { createContentEditDelta, createFrameDelta } from "../../core/src/utils/frameDelta";
import { createStreamingRecordingReader, encodeRecordingToStream } from ".";
import { decodeRecords, LEGACY_STREAM_FORMAT_VERSION } from "./format";

// Count every segment inflation the reader performs.
vi.mock("./format", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./format")>();
  return {
    ...actual,
    decodeRecords: vi.fn<typeof actual.decodeRecords>(actual.decodeRecords),
  };
});

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

describe("streaming reader retries", () => {
  it("does not re-inflate a complete segment that failed, and reports its own error", async () => {
    // A v2 stream whose first frame segment holds an exact edit delta (a v3 feature): it
    // inflates fine and then fails the format check, so its bytes can never decode.
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
    const cursorEvents = Array.from({ length: 200 }, (_, index) => ({
      timestamp: 20 + index,
      x: index,
      y: (index * 7919) % 601,
      visible: true,
    }));
    const bytes = await encodeRecordingToStream({
      version: 4,
      id: "retry",
      name: "Retry",
      createdAt: 1,
      duration: 1_000,
      keyframeInterval: 120,
      frames: [keyframe, createFrameDelta(keyframe, makeKeyframe(16, created.content), created)],
      cursorEvents,
    });
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(4, LEGACY_STREAM_FORMAT_VERSION, true);

    const reader = createStreamingRecordingReader();
    vi.mocked(decodeRecords).mockClear();
    const push = () => {
      for (let offset = 0; offset < bytes.length; offset += 16) {
        reader.push(bytes.subarray(offset, offset + 16));
      }
    };

    expect(push).toThrow(/content edit deltas require format version 3/);
    // Once when the segment completed, once more when the footer made the failure final.
    expect(vi.mocked(decodeRecords)).toHaveBeenCalledTimes(2);
  });
});
