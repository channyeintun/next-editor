import { describe, expect, it } from "vite-plus/test";
import type { PreviewDomPatchBatch, PreviewInitialDocument } from "../slides";
import { getRrwebReplayLead } from "./previewReplayLead";

const seed = (time: number, stamps: number[]): PreviewInitialDocument => ({
  version: 2,
  time,
  documentId: "d",
  events: stamps.map((timestamp) => ({ type: 2, data: {}, timestamp })),
});

const batch = (time: number, stamps: number[]): PreviewDomPatchBatch => ({
  version: 2,
  time,
  source: "runtime-preview",
  documentId: "d",
  events: stamps.map((timestamp) => ({ type: 3, data: {}, timestamp })),
});

describe("the preview clock's lead over the recording clock", () => {
  it("is -Infinity when no segment carries events", () => {
    expect(getRrwebReplayLead([], [])).toBe(-Infinity);
    expect(getRrwebReplayLead([seed(10, [])], [batch(20, [])])).toBe(-Infinity);
  });

  it("is the largest first-event lead over every segment", () => {
    // The batch reached the host fastest, so its lead wins over the seed's.
    expect(getRrwebReplayLead([seed(100, [60_000])], [batch(5_000, [65_000, 65_500])])).toBe(
      60_000,
    );
    expect(getRrwebReplayLead([seed(10, [60_000])], [batch(6_020, [66_000])])).toBe(59_990);
  });
});
