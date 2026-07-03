import { describe, expect, it } from "vitest";
import type { Recording } from "../../core/src";
import type { DeltaFrame } from "../../core/src/utils/deltaTypes";
import { normalizeRecordingData } from "../../core/src/utils/editorState";
import { createStreamingRecordingReader, decodeRecordingStream, encodeRecordingToStream } from ".";
import { hydrateFramePreviewContent, stripFramePreviewContent } from "./framePreviewContentDedup";
import {
  decodeRecords,
  findFooterStart,
  parseHeader,
  readSegmentHeader,
  SEGMENT_HEADER_SIZE,
  SEGMENT_KIND,
} from "./format";

// A static-preview HTML payload large enough that per-frame duplication would
// dominate the encoded size if the dedup ever regressed (each copy also sits
// beyond deflate's 32KB window in real recordings).
const PREVIEW_HTML = "<article>the same static preview document</article>".repeat(60); // ~3KB
const PREVIEW_HTML_V2 = "<article>updated preview document</article>".repeat(60);

function keyframe(timestamp: number, content: string): DeltaFrame {
  return {
    timestamp,
    isKeyframe: true,
    state: {
      content: "editor content",
      position: { lineNumber: 1, column: 1 },
      previewState: { isOpen: true, content, scrollTop: 0 },
    },
  } as unknown as DeltaFrame;
}

// Scroll tick: the delta format re-emits the whole previewState (content
// included) whenever any part of it — here scrollTop — changes.
function scrollDelta(timestamp: number, content: string, scrollTop: number): DeltaFrame {
  return {
    timestamp,
    isKeyframe: false,
    previewState: { isOpen: true, content, scrollTop },
  } as unknown as DeltaFrame;
}

// Two keyframe-bounded runs, both re-embedding the same preview content per
// scroll tick; the second run switches content mid-segment.
const FRAMES: DeltaFrame[] = [
  keyframe(0, PREVIEW_HTML),
  scrollDelta(16, PREVIEW_HTML, 10),
  scrollDelta(32, PREVIEW_HTML, 20),
  scrollDelta(48, PREVIEW_HTML, 30),
  keyframe(1_000, PREVIEW_HTML),
  scrollDelta(1_016, PREVIEW_HTML, 40),
  scrollDelta(1_032, PREVIEW_HTML_V2, 0),
  scrollDelta(1_048, PREVIEW_HTML_V2, 10),
];

function makeRecording(frames: DeltaFrame[]): Recording {
  return {
    version: 4,
    id: "recording-frame-preview-dedup",
    name: "Frame previewState content dedup round trip",
    createdAt: 1_700_000_000_000,
    duration: 2_000,
    keyframeInterval: 120,
    frames,
    streamFinalized: true,
  };
}

function frameContents(frames: DeltaFrame[] | undefined): (string | undefined)[] {
  return (frames ?? []).map((frame) => {
    const record = frame as unknown as {
      previewState?: { content?: string };
      state?: { previewState?: { content?: string } };
    };
    return record.previewState?.content ?? record.state?.previewState?.content;
  });
}

/** Raw (marker-carrying) frame records per frames-segment of an SCR3 stream. */
function rawFrameSegments(bytes: Uint8Array): DeltaFrame[][] {
  const { headerEnd } = parseHeader(bytes);
  const segmentsEnd = findFooterStart(bytes, headerEnd) ?? bytes.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segments: DeltaFrame[][] = [];
  let offset = headerEnd;
  while (offset + SEGMENT_HEADER_SIZE <= segmentsEnd) {
    const header = readSegmentHeader(view, offset);
    const payloadStart = offset + SEGMENT_HEADER_SIZE;
    if (header.kind === SEGMENT_KIND.frames) {
      segments.push(
        decodeRecords<DeltaFrame>(bytes.subarray(payloadStart, payloadStart + header.byteLength)),
      );
    }
    offset = payloadStart + header.byteLength;
  }
  return segments;
}

describe("frame previewState content dedup", () => {
  it("round-trips frames exactly through encode/decode", async () => {
    const bytes = await encodeRecordingToStream(makeRecording(FRAMES));
    const decoded = decodeRecordingStream(bytes);
    const expected = normalizeRecordingData(makeRecording(FRAMES)).frames;

    expect(decoded.frames).toEqual(expected);
    for (const frame of decoded.frames) {
      expect(JSON.stringify(frame)).not.toContain("contentDeduped");
    }
  });

  it("keeps every frames segment self-contained on the wire", async () => {
    const bytes = await encodeRecordingToStream(makeRecording(FRAMES));
    const segments = rawFrameSegments(bytes);

    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      const contents = frameContents(segment);
      // The first content-bearing frame of EVERY segment carries full content
      // (range-loading a keyframe-bounded segment must not need earlier ones);
      // later identical repeats within the segment are deduped to markers.
      const firstWithContent = contents.find((content) => content !== undefined);
      expect(firstWithContent).not.toBe("");
      expect(contents.filter((content) => content === "").length).toBeGreaterThan(0);
    }
  });

  it("stores repeated content once per segment and again on change", () => {
    const stripped = stripFramePreviewContent(FRAMES) as DeltaFrame[];
    const contents = frameContents(stripped);

    expect(contents).toEqual([
      PREVIEW_HTML, // keyframe: first occurrence, full
      "", // repeats dedupe…
      "",
      "",
      "", // …across the keyframe too (per-CALL carry; segmenting is the wiring's job)
      "",
      PREVIEW_HTML_V2, // content change: full again
      "", // and its repeat dedupes
    ]);

    // Hydrating in the same order restores the originals exactly.
    expect(hydrateFramePreviewContent(stripped)).toEqual(FRAMES);
  });

  it("does not mutate the frames being encoded", async () => {
    const frames = structuredClone(FRAMES);
    await encodeRecordingToStream(makeRecording(frames));

    expect(frames).toEqual(FRAMES);
  });

  it("hydrates identically through the incremental reader, chunk by chunk", async () => {
    const bytes = await encodeRecordingToStream(makeRecording(FRAMES));
    const reader = createStreamingRecordingReader();

    const CHUNK = 512;
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      reader.push(bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK)));
    }

    const streamed = reader.getRecording();
    expect(streamed?.frames).toEqual(normalizeRecordingData(makeRecording(FRAMES)).frames);
  });
});
