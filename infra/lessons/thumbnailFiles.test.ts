import { describe, expect, it } from "vite-plus/test";
import { isWriteOnceThumbnailKey, thumbnailExtension, thumbnailFilename } from "./thumbnailFiles";

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

describe("thumbnailExtension", () => {
  // resizeThumbnail names its output "<base>.webp"; anything the upload route
  // would refuse must never be forwarded.
  it("keeps a WebP thumbnail's extension, from its name or its type", () => {
    expect(thumbnailExtension(new File([], "cover.webp", { type: "image/webp" }))).toBe("webp");
    expect(thumbnailExtension(new File([], "blob", { type: "image/webp" }))).toBe("webp");
    expect(thumbnailExtension(new File([], "IMG_1234.JPG", { type: "image/jpeg" }))).toBe("jpg");
    expect(thumbnailExtension(new File([], "icon.svg", { type: "image/svg+xml" }))).toBe("png");
  });
});
