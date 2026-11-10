import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { decode as msgpackDecode, encode as msgpackEncode } from "@msgpack/msgpack";
import { zlibSync } from "fflate";
import { createStreamingRecordingReader, decodeRecordingStream } from "./decode";
import { createStreamingRecordingWriter } from "./encode";
import {
  buildFooterChunk,
  buildHeaderChunk,
  buildSegmentChunk,
  concatChunks,
  createInflationBudget,
  decodeRecords,
  encodeRecords,
  HEADER_PREFIX_SIZE,
  parseHeader,
  SEGMENT_KIND,
  STREAM_FORMAT_VERSION,
  type RecordingStreamMeta,
} from "./format";
import { measureMsgpackDecodedCost, MSGPACK_MAX_DEPTH } from "./msgpackBounds";

// Every call the codec makes into the MessagePack decoder. A refused document must
// never reach it: the decoder allocates from a declared length before reading on.
const decoder = vi.hoisted(() => ({ calls: 0 }));

vi.mock("@msgpack/msgpack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@msgpack/msgpack")>();
  return {
    ...actual,
    decode: (...args: Parameters<typeof actual.decode>) => {
      decoder.calls += 1;
      return actual.decode(...args);
    },
  };
});

const MiB = 1024 * 1024;
const VALUE_COST = 8;
const CONTAINER_COST = 24;

beforeEach(() => {
  decoder.calls = 0;
});

/** `count` nested `array32` headers, each declaring `length` elements and holding none. */
function nestedArrayHeaders(count: number, length: number): Uint8Array {
  const bytes = new Uint8Array(count * 5);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < count; index += 1) {
    view.setUint8(index * 5, 0xdd);
    view.setUint32(index * 5 + 1, length);
  }
  return bytes;
}

/** One array holding `count` empty arrays, a byte apiece. */
function emptyArrays(count: number): Uint8Array {
  const bytes = new Uint8Array(5 + count).fill(0x90);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 0xdd);
  view.setUint32(1, count);
  return bytes;
}

/** `depth` arrays nested one inside the next, the innermost empty. */
function nestedArrays(depth: number): Uint8Array {
  const bytes = new Uint8Array(depth).fill(0x91);
  bytes[depth - 1] = 0x90;
  return bytes;
}

function headerWithMeta(packedMeta: Uint8Array): Uint8Array {
  const payload = zlibSync(packedMeta);
  const bytes = new Uint8Array(HEADER_PREFIX_SIZE + payload.byteLength);
  const view = new DataView(bytes.buffer);
  bytes.set([0x53, 0x43, 0x52, 0x33], 0);
  view.setUint16(4, STREAM_FORMAT_VERSION, true);
  view.setUint32(8, payload.byteLength, true);
  bytes.set(payload, HEADER_PREFIX_SIZE);
  return bytes;
}

const META: RecordingStreamMeta = {
  version: 4,
  id: "bounds",
  name: "Bounds",
  keyframeInterval: 120,
  createdAt: 1,
  duration: 1_000,
};

describe("declared container lengths", () => {
  // Each five-byte header made the decoder run `new Array(2 ** 25)` before it read
  // another byte: 32 of them, 160 bytes, asked for gigabytes and only then failed.
  it("refuses a segment of nested array headers without decoding it", () => {
    const bomb = zlibSync(nestedArrayHeaders(32, 2 ** 25));
    expect(bomb.byteLength).toBeLessThan(64);

    expect(() => decodeRecords(bomb, createInflationBudget())).toThrow(
      /Invalid SCR3 stream: malformed record data/,
    );
    expect(() => decodeRecords(bomb)).toThrow(/Invalid SCR3 stream: malformed record data/);
    expect(decoder.calls).toBe(0);
  });

  it("refuses a header of nested array headers without decoding it", () => {
    expect(() => parseHeader(headerWithMeta(nestedArrayHeaders(32, 2 ** 25)))).toThrow(
      /Invalid SCR3 stream: malformed record data/,
    );
    expect(decoder.calls).toBe(0);
  });

  it("refuses a container that declares more items than bytes remain", () => {
    // An array of 3 with two elements present, and a map of 2 entries with three items.
    expect(() => measureMsgpackDecodedCost(new Uint8Array([0x93, 0x01, 0x02]))).toThrow(
      /malformed record data/,
    );
    expect(() => measureMsgpackDecodedCost(new Uint8Array([0x82, 0xa1, 0x61, 0x01]))).toThrow(
      /malformed record data/,
    );
    // Outstanding items are counted across every open container, not per container.
    expect(() =>
      measureMsgpackDecodedCost(new Uint8Array([0x93, 0x93, 0x93, 0x01, 0x01, 0x01, 0x01])),
    ).toThrow(/malformed record data/);
  });

  it("refuses the same streams through both readers", () => {
    const stream = concatChunks([
      buildHeaderChunk(META, 0),
      buildSegmentChunk(
        SEGMENT_KIND.cursor,
        zlibSync(nestedArrayHeaders(32, 2 ** 25)),
        0,
        0,
        -1,
        0,
        false,
      ),
      buildFooterChunk([
        { kind: SEGMENT_KIND.cursor, byteOffset: 0, firstTimestampMs: 0, firstFrameIndex: -1 },
      ]),
    ]);

    expect(() => decodeRecordingStream(stream)).toThrow(/malformed record data/);
    expect(() => createStreamingRecordingReader().push(stream)).toThrow(/malformed record data/);
  });
});

describe("decoded cost", () => {
  it("charges every value and container on top of the inflated bytes", () => {
    // [nil, [], {a: 1}, "hi"]: seven values (the map's key and value count), three containers.
    const packed = msgpackEncode([null, [], { a: 1 }, "hi"]);
    expect(measureMsgpackDecodedCost(packed)).toBe(
      packed.byteLength + 7 * VALUE_COST + 3 * CONTAINER_COST,
    );
  });

  // A byte per empty array decoded to a ~40-byte object each, so a payload inside the
  // inflated-byte budget built a heap many times larger than the budget allowed.
  it("refuses tiny values that decode far past the budget, without decoding them", () => {
    const payload = zlibSync(emptyArrays(MiB));
    expect(payload.byteLength).toBeLessThan(8 * 1024);

    expect(() => decodeRecords(payload, createInflationBudget(4 * MiB))).toThrow(
      /Invalid SCR3 stream: stream exceeds the decoded size limit/,
    );
    expect(decoder.calls).toBe(0);
  });

  it("debits the budget by the decoded cost, not the inflated size", () => {
    const records = [{ timestamp: 1, x: 2, y: 3, visible: true }];
    const packed = msgpackEncode(records);
    const budget = createInflationBudget(MiB);

    expect(decodeRecords(zlibSync(packed), budget)).toEqual(records);
    expect(MiB - budget.remaining).toBe(measureMsgpackDecodedCost(packed));
    expect(MiB - budget.remaining).toBeGreaterThan(packed.byteLength);
  });

  it("tells a writer the cost a reader charges for the same segment", () => {
    const records = [{ timestamp: 1, x: 2, y: 3, visible: true }, { nested: [[], {}] }];
    const encoded = encodeRecords(records);
    const budget = createInflationBudget(MiB);

    decodeRecords(encoded.payload, budget);
    expect(encoded.decodedCost).toBe(MiB - budget.remaining);
  });

  it("charges the header's metadata to the stream as well", () => {
    const meta = { ...META, chapters: [{ time: 0, title: "Start" }] };
    const { decodedCost } = parseHeader(buildHeaderChunk(meta, 0));
    expect(decodedCost).toBe(measureMsgpackDecodedCost(msgpackEncode(meta)));
  });

  it("still opens what the writer accepted", () => {
    const writer = createStreamingRecordingWriter();
    writer.writeHeader(META);
    const cursorEvents = Array.from({ length: 2_000 }, (_, index) => ({
      timestamp: index,
      x: index,
      y: index,
      visible: true,
    }));
    writer.appendEventSegment(SEGMENT_KIND.cursor, cursorEvents);

    expect(decodeRecordingStream(writer.finalize()).cursorEvents).toEqual(cursorEvents);
  });
});

describe("nesting depth", () => {
  it("accepts the deepest document a writer can produce", () => {
    let deepest: unknown[] = [];
    for (let depth = 1; depth < MSGPACK_MAX_DEPTH - 1; depth += 1) deepest = [deepest];
    // One more level and the encoder itself refuses.
    expect(() => encodeRecords([[deepest]])).toThrow(/Too deep/);

    const encoded = encodeRecords([deepest]);
    expect(decodeRecords(encoded.payload)).toEqual([deepest]);
  });

  it("refuses a document nested deeper than a writer can produce", () => {
    expect(() => measureMsgpackDecodedCost(nestedArrays(MSGPACK_MAX_DEPTH + 1))).not.toThrow();
    expect(() => measureMsgpackDecodedCost(nestedArrays(MSGPACK_MAX_DEPTH + 2))).toThrow(
      /Invalid SCR3 stream: record data is nested too deeply/,
    );
    expect(() => decodeRecords(zlibSync(nestedArrays(100_000)))).toThrow(/nested too deeply/);
    expect(decoder.calls).toBe(0);
  });
});

describe("structural agreement with the decoder", () => {
  // One of everything the encoder can emit, across each length class.
  const DOCUMENT = [
    null,
    true,
    false,
    0,
    127,
    -1,
    -32,
    255,
    65_535,
    4_294_967_295,
    Number.MAX_SAFE_INTEGER,
    -129,
    -32_769,
    -2_147_483_649,
    1.5,
    "",
    "short",
    "a".repeat(32),
    "b".repeat(300),
    "c".repeat(70_000),
    new Uint8Array(3),
    new Uint8Array(300),
    new Uint8Array(70_000),
    new Date(1_700_000_000_000),
    new Date(-1),
    [],
    Array.from({ length: 16 }, (_, index) => index),
    Array.from({ length: 70_000 }, () => null),
    {},
    Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`k${index}`, index])),
    Object.fromEntries(Array.from({ length: 70_000 }, (_, index) => [`k${index}`, []])),
    { nested: [{ deeper: [1, [2, [3]]] }] },
  ];

  it("measures a document holding every MessagePack type", () => {
    const packed = msgpackEncode(DOCUMENT);
    const cost = measureMsgpackDecodedCost(packed);
    expect(cost).toBeGreaterThan(packed.byteLength);
    expect(msgpackDecode(packed)).toEqual(DOCUMENT);
  });

  it("refuses every truncation the decoder refuses", () => {
    // The large members are dropped here so every prefix can be tried.
    const packed = msgpackEncode(
      DOCUMENT.filter(
        (value) =>
          !(typeof value === "string" && value.length > 1_000) &&
          !(value instanceof Uint8Array && value.byteLength > 1_000) &&
          !(typeof value === "object" && value !== null && Object.keys(value).length > 1_000),
      ),
    );
    expect(packed.byteLength).toBeGreaterThan(500);

    for (let length = 0; length < packed.byteLength; length += 1) {
      const prefix = packed.subarray(0, length);
      expect(() => measureMsgpackDecodedCost(prefix), `prefix of ${length}`).toThrow(
        /malformed record data/,
      );
      expect(() => msgpackDecode(prefix), `prefix of ${length}`).toThrow(RangeError);
    }
  });

  it("refuses the reserved type byte", () => {
    expect(() => measureMsgpackDecodedCost(new Uint8Array([0x91, 0xc1]))).toThrow(
      /malformed record data/,
    );
  });
});
