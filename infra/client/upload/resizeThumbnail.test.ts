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
  // Each canvas call is logged with the fill and compositing state it ran
  // under, so a test can check what was painted, how, and in what order.
  const calls: string[] = [];
  const ctx = {
    fillStyle: "#000000",
    globalCompositeOperation: "source-over",
    drawImage: vi.fn<() => void>(() => {
      calls.push("drawImage");
    }),
    fillRect: vi.fn<(x: number, y: number, w: number, h: number) => void>((x, y, w, h) => {
      calls.push(`fillRect(${x},${y},${w},${h}) ${ctx.fillStyle} ${ctx.globalCompositeOperation}`);
    }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  const toBlob = vi
    .spyOn(HTMLCanvasElement.prototype, "toBlob")
    .mockImplementation((callback, type = "image/png") => {
      calls.push(`toBlob ${type}`);
      const encoded = type === "image/webp" && !encodesWebp ? "image/png" : type;
      callback(new Blob(["bytes"], { type: encoded }));
    });
  return { toBlob, ctx, calls };
}

describe("resizeThumbnail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("re-encodes a raster image as WebP", async () => {
    const { toBlob, ctx } = stubCanvas({ encodesWebp: true });

    const result = await resizeThumbnail(new File(["png"], "IMG_1234.PNG", { type: "image/png" }));

    expect(result.name).toBe("IMG_1234.webp");
    expect(result.type).toBe("image/webp");
    expect(toBlob).toHaveBeenCalledOnce();
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), "image/webp", 0.82);
    // WebP keeps alpha, so a transparent logo stays transparent.
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  it("falls back to JPEG where the browser can't encode WebP", async () => {
    const { toBlob } = stubCanvas({ encodesWebp: false });

    const result = await resizeThumbnail(new File(["png"], "cover.png", { type: "image/png" }));

    expect(result.name).toBe("cover.jpg");
    expect(result.type).toBe("image/jpeg");
    expect(toBlob).toHaveBeenLastCalledWith(expect.any(Function), "image/jpeg", 0.85);
  });

  it("paints white behind the image before the JPEG fallback encodes it", async () => {
    const { ctx, calls } = stubCanvas({ encodesWebp: false });

    await resizeThumbnail(new File(["png"], "logo.png", { type: "image/png" }));

    // JPEG has no alpha: without a fill, transparent pixels encode as black.
    // destination-over paints the white behind what is already drawn.
    expect(calls).toEqual([
      "drawImage",
      "toBlob image/webp",
      "fillRect(0,0,640,360) #fff destination-over",
      "toBlob image/jpeg",
    ]);
    expect(ctx.globalCompositeOperation).toBe("source-over");
  });
});
