import { describe, expect, it } from "vite-plus/test";
import { hasRrwebPreviewSeed, type PreviewInitialDocument } from "./preview";

describe("hasRrwebPreviewSeed", () => {
  const seed: PreviewInitialDocument = {
    version: 2,
    time: 0,
    documentId: "doc-1",
    events: [
      { type: 4, timestamp: 0, data: {} },
      { type: 2, timestamp: 0, data: {} },
    ],
  };

  it("detects a recording whose rrweb stream has a seed", () => {
    expect(hasRrwebPreviewSeed([seed])).toBe(true);
  });

  it("returns false for legacy records and empty input", () => {
    const legacy: PreviewInitialDocument = {
      version: 2,
      time: 0,
      documentId: "doc-1",
    };

    expect(hasRrwebPreviewSeed([legacy])).toBe(false);
    expect(hasRrwebPreviewSeed([])).toBe(false);
    expect(hasRrwebPreviewSeed(undefined)).toBe(false);
  });
});
