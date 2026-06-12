import { describe, expect, it } from "vite-plus/test";
import { clampCustomPreviewSize, getCustomPreviewSizeFromResize } from "./previewSizeUtils";

describe("clampCustomPreviewSize", () => {
  it("caps custom preview width to the viewport gutter", () => {
    const size = clampCustomPreviewSize({ width: 1200, height: 360 }, { width: 800, height: 900 });

    expect(size).toEqual({ width: 768, height: 360 });
  });

  it("keeps minimum custom dimensions when the viewport allows them", () => {
    const size = clampCustomPreviewSize({ width: 80, height: 80 }, { width: 800, height: 900 });

    expect(size).toEqual({ width: 160, height: 120 });
  });

  it("uses the viewport limit when the viewport is narrower than the minimum width", () => {
    const size = clampCustomPreviewSize({ width: 400, height: 180 }, { width: 120, height: 900 });

    expect(size).toEqual({ width: 88, height: 180 });
  });
});

describe("getCustomPreviewSizeFromResize", () => {
  it("grows from the bottom-left handle when dragged left and down", () => {
    const size = getCustomPreviewSizeFromResize({
      startSize: { width: 320, height: 448 },
      startPointer: { x: 100, y: 500 },
      currentPointer: { x: 40, y: 560 },
      viewport: { width: 1000, height: 900 },
    });

    expect(size).toEqual({ width: 380, height: 508 });
  });

  it("shrinks from the bottom-left handle when dragged right and up", () => {
    const size = getCustomPreviewSizeFromResize({
      startSize: { width: 320, height: 448 },
      startPointer: { x: 100, y: 500 },
      currentPointer: { x: 180, y: 440 },
      viewport: { width: 1000, height: 900 },
    });

    expect(size).toEqual({ width: 240, height: 388 });
  });

  it("clamps dragged size to viewport bounds", () => {
    const size = getCustomPreviewSizeFromResize({
      startSize: { width: 320, height: 448 },
      startPointer: { x: 100, y: 500 },
      currentPointer: { x: -1000, y: 1200 },
      viewport: { width: 800, height: 900 },
    });

    expect(size).toEqual({ width: 768, height: 804 });
  });
});
