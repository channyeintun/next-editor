import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { resizeThumbnail } from "./resizeThumbnail";

// jsdom has neither createImageBitmap nor a canvas backend, so both are stood
// in for. `encodesWebp: false` mimics a browser without a WebP encoder, whose
// toBlob hands back a PNG for the unsupported type.
function stubCanvas({ encodesWebp }: { encodesWebp: boolean }) {
  const bitmap = { width: 1920, height: 1080, close: vi.fn<() => void>() };
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn<() => Promise<typeof bitmap>>(async () => bitmap),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn<() => void>(),
  } as unknown as CanvasRenderingContext2D);
  return vi
    .spyOn(HTMLCanvasElement.prototype, "toBlob")
    .mockImplementation((callback, type = "image/png") => {
      const encoded = type === "image/webp" && !encodesWebp ? "image/png" : type;
      callback(new Blob(["bytes"], { type: encoded }));
    });
}

describe("resizeThumbnail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("re-encodes a raster image as WebP", async () => {
    const toBlob = stubCanvas({ encodesWebp: true });

    const result = await resizeThumbnail(new File(["png"], "IMG_1234.PNG", { type: "image/png" }));

    expect(result.name).toBe("IMG_1234.webp");
    expect(result.type).toBe("image/webp");
    expect(toBlob).toHaveBeenCalledOnce();
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), "image/webp", 0.82);
  });

  it("falls back to JPEG where the browser can't encode WebP", async () => {
    const toBlob = stubCanvas({ encodesWebp: false });

    const result = await resizeThumbnail(new File(["png"], "cover.png", { type: "image/png" }));

    expect(result.name).toBe("cover.jpg");
    expect(result.type).toBe("image/jpeg");
    expect(toBlob).toHaveBeenLastCalledWith(expect.any(Function), "image/jpeg", 0.85);
  });
});
