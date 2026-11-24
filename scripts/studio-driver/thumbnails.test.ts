// @vitest-environment node
import { describe, expect, it } from "vitest";
import { thumbnailTypeOf } from "./thumbnails.ts";

describe("thumbnails", () => {
  it("takes the image types the site takes as thumbnails", () => {
    expect(thumbnailTypeOf("rust-borrow.png")).toBe("image/png");
    expect(thumbnailTypeOf("a.JPG")).toBe("image/jpeg");
    expect(thumbnailTypeOf("a.jpeg")).toBe("image/jpeg");
    expect(thumbnailTypeOf("a.svg")).toBeNull();
    expect(thumbnailTypeOf("notes.txt")).toBeNull();
  });
});
