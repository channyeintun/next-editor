import { describe, expect, it } from "vite-plus/test";
import { isWriteOnceThumbnailKey, thumbnailFilename } from "./thumbnailFiles";

describe("thumbnailFilename", () => {
  it("names every upload with its own timestamp", () => {
    expect(thumbnailFilename("l1", "webp", 1_791_222_405_295)).toBe(
      "l1-thumbnail-1791222405295.webp",
    );
    expect(thumbnailFilename("l1", "jpg", 1_791_222_405_296)).toBe(
      "l1-thumbnail-1791222405296.jpg",
    );
  });
});

describe("isWriteOnceThumbnailKey", () => {
  it("recognizes a lesson's timestamped thumbnail under its own folder", () => {
    expect(isWriteOnceThumbnailKey(`lessons/l1/${thumbnailFilename("l1", "webp")}`)).toBe(true);
    expect(isWriteOnceThumbnailKey("lessons/l1/l1-thumbnail-1791222405295.jpeg")).toBe(true);
  });

  it("leaves every other key revalidated", () => {
    // An older row's fixed name, replaceable in place.
    expect(isWriteOnceThumbnailKey("lessons/l1/l1-thumbnail.jpg")).toBe(false);
    // Another lesson's name in this folder, an unknown type, a recording.
    expect(isWriteOnceThumbnailKey("lessons/l1/l2-thumbnail-1791222405295.jpg")).toBe(false);
    expect(isWriteOnceThumbnailKey("lessons/l1/l1-thumbnail-1791222405295.svg")).toBe(false);
    expect(isWriteOnceThumbnailKey("lessons/l1/l1.ne")).toBe(false);
  });
});
