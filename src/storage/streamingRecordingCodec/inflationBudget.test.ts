import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { decode as msgpackDecode, encode as msgpackEncode } from "@msgpack/msgpack";
import { unzlibSync, zlibSync, type FlateStreamHandler } from "fflate";
import {
  createInflationBudget,
  decodeRecords,
  HEADER_PREFIX_SIZE,
  MAX_COMPRESSED_META_BYTES,
  MAX_INFLATED_STREAM_BYTES,
  parseHeader,
  STREAM_FORMAT_VERSION,
} from "./format";

// The largest single chunk the decoder's inflater handed back. The size limit is
// checked per chunk, so this is the most memory a stream can make the decoder
// allocate before the limit gets a chance to refuse it.
const inflated = vi.hoisted(() => ({ largestChunk: 0 }));

vi.mock("fflate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fflate")>();
  class ChunkRecordingUnzlib extends actual.Unzlib {
    constructor(callback?: FlateStreamHandler) {
      super((chunk, final) => {
        inflated.largestChunk = Math.max(inflated.largestChunk, chunk.byteLength);
        callback?.(chunk, final);
      });
    }
  }
  return { ...actual, Unzlib: ChunkRecordingUnzlib };
});

const MiB = 1024 * 1024;

beforeEach(() => {
  inflated.largestChunk = 0;
});

/** One segment holding a single highly-compressible record of `size` bytes. */
function segmentOf(size: number): Uint8Array {
  return zlibSync(msgpackEncode([{ blob: "a".repeat(size) }]));
}

/** A header whose zlib'd metadata is `payload`, behind a valid stream prefix. */
function headerWithMeta(payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(HEADER_PREFIX_SIZE + payload.byteLength);
  const view = new DataView(bytes.buffer);
  bytes.set([0x53, 0x43, 0x52, 0x33], 0);
  view.setUint16(4, STREAM_FORMAT_VERSION, true);
  view.setUint32(8, payload.byteLength, true);
  bytes.set(payload, HEADER_PREFIX_SIZE);
  return bytes;
}

/**
 * A segment whose compressed payload is exactly `size` bytes. Stored (level 0)
 * blocks grow one byte per blob byte, so a short search lands on any size.
 */
function segmentOfCompressedSize(size: number): {
  payload: Uint8Array;
  records: Array<{ blob: Uint8Array }>;
} {
  for (let length = size; length >= 0; length -= 1) {
    const records = [{ blob: new Uint8Array(length).map((_, i) => (i * 31) & 0xff) }];
    const payload = zlibSync(msgpackEncode(records), { level: 0 });
    if (payload.byteLength === size) return { payload, records };
  }
  throw new Error(`no stored segment compresses to ${size} bytes`);
}

/** A record of `size` pseudo-random letters: it deflates to many dynamic blocks. */
function lettersOf(size: number): string {
  let seed = 0x2545f491;
  let text = "";
  for (let i = 0; i < size; i += 1) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    text += String.fromCharCode(97 + ((seed >>> 16) % 26));
  }
  return text;
}

describe("stream inflation budget", () => {
  it("decodes normally when no budget is supplied", () => {
    const records = decodeRecords<{ blob: string }>(segmentOf(1024));
    expect(records[0].blob.length).toBe(1024);
  });

  it("shares one budget across segments and refuses the stream past the ceiling", () => {
    // The per-segment cap alone never fires here: each segment is small. What is
    // being exercised is the *sum*, which nothing bounded before — DEFLATE's
    // ~1000:1 ratio let a couple of MB on the wire retain gigabytes.
    const segment = segmentOf(1024 * 1024);
    expect(segment.byteLength).toBeLessThan(8 * 1024);

    const budget = createInflationBudget(4 * 1024 * 1024);
    // Each segment costs ~1 MiB of the shared budget, so a handful succeed and
    // the stream is then refused — without a shared budget every one of these
    // would decode forever, since none approaches the per-segment cap.
    let decoded = 0;
    expect(() => {
      for (let i = 0; i < 64; i += 1) {
        decodeRecords<{ blob: string }>(segment, budget);
        decoded += 1;
      }
    }).toThrow(/decoded size limit/);

    expect(decoded).toBeGreaterThanOrEqual(3);
    expect(decoded).toBeLessThanOrEqual(4);
  });

  it("leaves enormous headroom over any real recording", () => {
    expect(MAX_INFLATED_STREAM_BYTES).toBeGreaterThanOrEqual(512 * 1024 * 1024);
  });
});

describe("deflate bombs", () => {
  // A single push of the whole payload made fflate inflate everything into one
  // chunk, so the size check ran only after the full bomb was in memory.
  it("refuses a segment bomb before inflating it in full", () => {
    const bomb = zlibSync(new Uint8Array(64 * MiB));

    expect(() => decodeRecords(bomb, createInflationBudget(MiB))).toThrow(
      /exceeds the decoded size limit/,
    );
    expect(inflated.largestChunk).toBeGreaterThan(0);
    expect(inflated.largestChunk).toBeLessThanOrEqual(8 * MiB);
  });

  it("refuses a header bomb before inflating it in full", () => {
    const bomb = zlibSync(new Uint8Array(64 * MiB));
    expect(bomb.byteLength).toBeLessThanOrEqual(MAX_COMPRESSED_META_BYTES);

    expect(() => parseHeader(headerWithMeta(bomb))).toThrow(
      /header exceeds the decoded size limit/,
    );
    expect(inflated.largestChunk).toBeGreaterThan(0);
    expect(inflated.largestChunk).toBeLessThanOrEqual(8 * MiB);
  });
});

describe("sliced inflation parity", () => {
  it("refuses empty and one-byte payloads just as a one-shot inflate does", () => {
    for (const payload of [new Uint8Array(0), new Uint8Array([0x78])]) {
      expect(() => unzlibSync(payload)).toThrow(/invalid zlib data/);
      expect(() => decodeRecords(payload)).toThrow(/invalid zlib data/);
    }
  });

  it.each([4095, 4096, 4097])("decodes a %i-byte compressed segment unchanged", (size) => {
    const { payload, records } = segmentOfCompressedSize(size);
    expect(payload.byteLength).toBe(size);
    expect(decodeRecords(payload)).toEqual(records);
  });

  it("decodes a multi-MiB record unchanged across many slices", () => {
    const records = [{ blob: lettersOf(3 * MiB) }, { tail: 1 }];
    const payload = zlibSync(msgpackEncode(records));
    expect(payload.byteLength).toBeGreaterThan(MiB);

    const decoded = decodeRecords(payload);
    expect(decoded).toEqual(msgpackDecode(unzlibSync(payload)));
    expect(decoded).toEqual(records);
  });
});
