import { describe, expect, it, vi } from "vitest";
import type { RecordingStreamMeta } from "./format";
import { decodeRecordingStream } from "./decode";
import { createStreamingRecordingWriter } from "./encode";
import { SEGMENT_KIND } from "./format";

// The whole-stream read limits are hundreds of MiB or a million records. Shrink them so
// the writer's refusals can be exercised with small inputs; the writer and the one-shot
// decoder both read these exports. (Per-segment and header limits are read inside
// format.ts and keep their real values.)
vi.mock("./format", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./format")>()),
  MAX_STREAM_BYTES: 64 * 1024,
  MAX_INFLATED_STREAM_BYTES: 64 * 1024,
  MAX_DECODED_RECORDS: 1_000,
}));

const meta: RecordingStreamMeta = {
  version: 4,
  id: "limits",
  name: "Limits",
  keyframeInterval: 120,
  createdAt: 1,
  duration: 1_000,
};

function asset(index: number, size: number) {
  return {
    descriptor: { kind: "asset" as const, assetId: `asset-${index}`, mimeType: "image/png", size },
    bytes: new Uint8Array(size),
  };
}

describe("SCR3 writer read limits", () => {
  it("refuses the segment that would make the file larger than a reader accepts", () => {
    const writer = createStreamingRecordingWriter();
    writer.writeHeader(meta);
    for (let index = 0; index < 3; index += 1) {
      writer.appendWorkspaceAssetSegment(asset(index, 16 * 1024));
    }

    expect(() => writer.appendWorkspaceAssetSegment(asset(3, 16 * 1024))).toThrow(
      /Recording is too large to save: the \.ne file would exceed/,
    );
    // Everything accepted before the refusal still finalizes into a stream readers open.
    const decoded = decodeRecordingStream(writer.finalize());
    expect(decoded.streamFinalized).toBe(true);
    expect(decoded.workspaceAssets).toHaveLength(3);
  });

  it("refuses records past the count a reader decodes", () => {
    const writer = createStreamingRecordingWriter();
    writer.writeHeader(meta);
    const cursorEvents = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        timestamp: from + index,
        x: 0,
        y: 0,
        visible: true,
      }));
    writer.appendEventSegment(SEGMENT_KIND.cursor, cursorEvents(0, 600));

    expect(() => writer.appendEventSegment(SEGMENT_KIND.cursor, cursorEvents(600, 600))).toThrow(
      /Recording is too large to save: it would hold more than 1000 records/,
    );
  });

  it("refuses records that would inflate past a reader's stream budget", () => {
    const writer = createStreamingRecordingWriter();
    writer.writeHeader(meta);
    // Repetitive text deflates to almost nothing, so only the inflated size can trip.
    const chatEvent = (timestamp: number) => ({
      timestamp,
      event: { k: "draft", text: "a".repeat(40 * 1024) },
    });
    writer.appendEventSegment(SEGMENT_KIND.chat, [chatEvent(0)]);

    expect(() => writer.appendEventSegment(SEGMENT_KIND.chat, [chatEvent(1)])).toThrow(
      /Recording is too large to save: its records would exceed .* once decoded/,
    );
  });
});
