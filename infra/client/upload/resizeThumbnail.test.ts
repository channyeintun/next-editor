import { describe, expect, it } from "vitest";
import { resizeThumbnail } from "./resizeThumbnail";

describe("resizeThumbnail", () => {
  it("passes an SVG through unchanged rather than rasterizing it", async () => {
    const file = new File(["<svg></svg>"], "icon.svg", { type: "image/svg+xml" });

    const result = await resizeThumbnail(file);

    expect(result).toBe(file);
  });
});
