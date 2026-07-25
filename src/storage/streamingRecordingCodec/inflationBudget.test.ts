import { describe, expect, it } from "vitest";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import { zlibSync } from "fflate";
import { createInflationBudget, decodeRecords, MAX_INFLATED_STREAM_BYTES } from "./format";

/** One segment holding a single highly-compressible record of `size` bytes. */
function segmentOf(size: number): Uint8Array {
  return zlibSync(msgpackEncode([{ blob: "a".repeat(size) }]));
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
