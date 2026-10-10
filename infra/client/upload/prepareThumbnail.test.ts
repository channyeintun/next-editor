import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { prepareThumbnail } from "./prepareThumbnail";
import { resizeThumbnail } from "./resizeThumbnail";
import { THUMBNAIL_ACCEPT } from "./thumbnailConstraints";

vi.mock("./resizeThumbnail", () => ({
  resizeThumbnail: vi.fn<(file: File) => Promise<File>>(),
}));

const mockedResize = vi.mocked(resizeThumbnail);

function image(type: string, size = 4): File {
  return new File([new Uint8Array(size)], "cover", { type });
}

describe("prepareThumbnail", () => {
  afterEach(() => {
    mockedResize.mockReset();
  });

  it("returns the resized PNG or JPG", async () => {
    const resized = image("image/webp");
    mockedResize.mockResolvedValue(resized);

    await expect(prepareThumbnail(image("image/png"))).resolves.toEqual({ file: resized });
    await expect(prepareThumbnail(image("image/jpeg"))).resolves.toEqual({ file: resized });
  });

  it("refuses any other type before reading it", async () => {
    for (const type of ["image/webp", "image/svg+xml", "image/gif", ""]) {
      await expect(prepareThumbnail(image(type))).resolves.toEqual({
        error: "Choose a PNG or JPG image.",
      });
    }
    expect(mockedResize).not.toHaveBeenCalled();
  });

  it("refuses an image over the limit before reading it", async () => {
    const result = await prepareThumbnail(image("image/png", 5 * 1024 * 1024 + 1));

    expect(result).toEqual({ error: "Image is too large — 5MB max." });
    expect(mockedResize).not.toHaveBeenCalled();
  });

  it("accepts an image exactly at the limit", async () => {
    mockedResize.mockResolvedValue(image("image/webp"));

    const result = await prepareThumbnail(image("image/png", 5 * 1024 * 1024));

    expect("file" in result).toBe(true);
  });

  // A renamed or corrupt file passes the type and size checks, then
  // createImageBitmap rejects inside resizeThumbnail.
  it("says so when the image can't be read", async () => {
    mockedResize.mockRejectedValue(new DOMException("The source image could not be decoded."));

    await expect(prepareThumbnail(image("image/png"))).resolves.toEqual({
      error: "Couldn't read that image — try a different file.",
    });
  });

  it("checks the same types the picker offers", () => {
    expect(THUMBNAIL_ACCEPT).toBe("image/png,image/jpeg");
  });
});
