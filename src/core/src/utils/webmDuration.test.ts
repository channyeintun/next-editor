import { describe, expect, it } from "vite-plus/test";
import { fixWebmDuration } from "./webmDuration";

// ---------------------------------------------------------------------------
// Independent WebM fixture builders + verifier (deliberately not sharing the
// module's own encoder, so the test validates against the EBML spec, not against
// the implementation's understanding of it).
// ---------------------------------------------------------------------------

const SEGMENT_ID = [0x18, 0x53, 0x80, 0x67];
const INFO_ID = [0x15, 0x49, 0xa9, 0x66];
const TIMECODE_SCALE_ID = [0x2a, 0xd7, 0xb1];
const DURATION_ID = [0x44, 0x89];
const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];
const EBML_HEADER_ID = [0x1a, 0x45, 0xdf, 0xa3];
const SEGMENT_UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

const bytes = (...values: number[]) => Uint8Array.from(values);

const concat = (...parts: Uint8Array[]) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** Minimal shortest-length size vint (matches the EBML spec's unknown-sentinel avoidance). */
const sizeVint = (value: number): Uint8Array => {
  let length = 1;
  while (value > 2 ** (7 * length) - 2) length += 1;
  const out = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
};

const el = (id: number[], content: Uint8Array) =>
  concat(Uint8Array.from(id), sizeVint(content.length), content);

const uintBytes = (value: number): Uint8Array => {
  const out: number[] = [];
  let remaining = value;
  do {
    out.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  return Uint8Array.from(out);
};

interface WebmFixtureOptions {
  timecodeScale?: number;
  /** Present-but-stale Duration (as MediaRecorder never writes) to exercise the replace path. */
  existingDuration?: { widthBytes: 4 | 8; value: number };
  withEbmlHeader?: boolean;
  definiteSegment?: boolean;
}

const durationElement = (widthBytes: 4 | 8, value: number) => {
  const content = new Uint8Array(widthBytes);
  const view = new DataView(content.buffer);
  if (widthBytes === 4) view.setFloat32(0, value, false);
  else view.setFloat64(0, value, false);
  return el(DURATION_ID, content);
};

const buildWebm = (options: WebmFixtureOptions = {}) => {
  const infoChildren: Uint8Array[] = [];
  if (options.timecodeScale !== undefined) {
    infoChildren.push(el(TIMECODE_SCALE_ID, uintBytes(options.timecodeScale)));
  }
  // A non-Duration child so Info is never empty (MuxingApp-shaped filler).
  infoChildren.push(el([0x4d, 0x80], bytes(0x54, 0x65, 0x73, 0x74)));
  if (options.existingDuration) {
    infoChildren.push(
      durationElement(options.existingDuration.widthBytes, options.existingDuration.value),
    );
  }

  const info = el(INFO_ID, concat(...infoChildren));
  const cluster = el(CLUSTER_ID, bytes(0xe7, 0x81, 0x00, 0xa3, 0x82, 0x00, 0x01));
  const segmentContent = concat(info, cluster);

  const segment = options.definiteSegment
    ? el(SEGMENT_ID, segmentContent)
    : concat(Uint8Array.from(SEGMENT_ID), Uint8Array.from(SEGMENT_UNKNOWN_SIZE), segmentContent);

  const top = options.withEbmlHeader
    ? concat(el(EBML_HEADER_ID, bytes(0x42, 0x86, 0x81, 0x01)), segment)
    : segment;

  return { blob: new Blob([top], { type: "video/webm;codecs=vp9,opus" }), cluster };
};

/** Read the first Duration element's value from a WebM byte array (8-byte double only). */
const readInjectedDuration = (buf: Uint8Array): number | null => {
  for (let i = 0; i + 10 < buf.length; i += 1) {
    if (buf[i] === DURATION_ID[0] && buf[i + 1] === DURATION_ID[1] && buf[i + 2] === 0x88) {
      return new DataView(buf.buffer, buf.byteOffset + i + 3, 8).getFloat64(0, false);
    }
  }
  return null;
};

const toBytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

const indexOfSubarray = (haystack: Uint8Array, needle: Uint8Array): number => {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
};

describe("fixWebmDuration", () => {
  it("returns the original blob for non-WebM / garbage input", async () => {
    const original = new Blob([bytes(0x76, 0x76, 0x76)], { type: "video/webm" });
    const result = await fixWebmDuration(original, 5000);
    expect(result).toBe(original);
  });

  it("returns the original blob when duration is not positive", async () => {
    const { blob } = buildWebm({ timecodeScale: 1_000_000 });
    expect(await fixWebmDuration(blob, 0)).toBe(blob);
    expect(await fixWebmDuration(blob, -1)).toBe(blob);
  });

  it("injects a Duration element (in ms) when none exists", async () => {
    const { blob } = buildWebm({ timecodeScale: 1_000_000, withEbmlHeader: true });
    const before = await toBytes(blob);

    const result = await fixWebmDuration(blob, 12_345);
    const after = await toBytes(result);

    // Duration element = 2-byte ID + 1-byte size + 8-byte double = 11 bytes.
    expect(after.length).toBe(before.length + 11);
    expect(readInjectedDuration(after)).toBeCloseTo(12_345, 3);
  });

  it("preserves trailing cluster bytes after the injected header", async () => {
    const { blob, cluster } = buildWebm({ timecodeScale: 1_000_000 });
    const result = await fixWebmDuration(blob, 8_000);
    const after = await toBytes(result);
    expect(indexOfSubarray(after, cluster)).toBeGreaterThanOrEqual(0);
  });

  it("scales the value by a non-default TimecodeScale", async () => {
    // 500000 ns/unit → half a millisecond per unit → value is 2× the ms count.
    const { blob } = buildWebm({ timecodeScale: 500_000 });
    const result = await fixWebmDuration(blob, 10_000);
    expect(readInjectedDuration(await toBytes(result))).toBeCloseTo(20_000, 3);
  });

  it("overwrites a stale existing Duration", async () => {
    const { blob } = buildWebm({
      timecodeScale: 1_000_000,
      existingDuration: { widthBytes: 4, value: 0 },
    });
    const result = await fixWebmDuration(blob, 4_200);
    expect(readInjectedDuration(await toBytes(result))).toBeCloseTo(4_200, 3);
  });

  it("widens a definite Segment size and stays parseable", async () => {
    const { blob, cluster } = buildWebm({ timecodeScale: 1_000_000, definiteSegment: true });
    const result = await fixWebmDuration(blob, 7_000);
    const after = await toBytes(result);

    expect(readInjectedDuration(after)).toBeCloseTo(7_000, 3);
    expect(indexOfSubarray(after, cluster)).toBeGreaterThanOrEqual(0);

    // The Segment's declared size must now cover the injected 11 bytes: re-read it and confirm it
    // spans to the end of the file.
    const segIdIndex = indexOfSubarray(after, Uint8Array.from(SEGMENT_ID));
    const sizeFirst = after[segIdIndex + SEGMENT_ID.length];
    // Size vint length from the leading-bit position.
    let mask = 0x80;
    let sizeLen = 1;
    while ((sizeFirst & mask) === 0) {
      mask >>= 1;
      sizeLen += 1;
    }
    let declared = sizeFirst & (mask - 1);
    for (let i = 1; i < sizeLen; i += 1) {
      declared = declared * 256 + after[segIdIndex + SEGMENT_ID.length + i];
    }
    const contentStart = segIdIndex + SEGMENT_ID.length + sizeLen;
    expect(contentStart + declared).toBe(after.length);
  });
});
