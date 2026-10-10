// Phone camera photos and screenshots are often several megapixels — far more
// than an aspect-video card thumbnail ever displays — so every raster upload
// is downscaled and re-encoded as a compact WebP before it reaches R2. WebP is
// about 57% smaller than JPEG for these cards (a gallery page of 12 drops from
// ~440 KB to ~190 KB). A browser that can't encode WebP hands back a PNG
// instead of failing (toBlob's fallback for an unsupported type), so the
// result's type is checked and JPEG is encoded instead.
const MAX_THUMBNAIL_DIMENSION = 640;
const THUMBNAIL_WEBP_QUALITY = 0.82;
const THUMBNAIL_JPEG_QUALITY = 0.85;

function encodeCanvas(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function resizeThumbnail(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    // Never upscale — a source image already smaller than the target is left
    // at its own size rather than blown up and softened.
    const scale = Math.min(1, MAX_THUMBNAIL_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file; // Unsupported environment — fall back to the original.
    ctx.drawImage(bitmap, 0, 0, width, height);

    const webp = await encodeCanvas(canvas, "image/webp", THUMBNAIL_WEBP_QUALITY);
    const isWebp = webp?.type === "image/webp";
    const blob = isWebp ? webp : await encodeCanvas(canvas, "image/jpeg", THUMBNAIL_JPEG_QUALITY);
    if (!blob) return file;

    const name = `${file.name.replace(/\.[^./]+$/, "")}.${isWebp ? "webp" : "jpg"}`;
    return new File([blob], name, { type: isWebp ? "image/webp" : "image/jpeg" });
  } finally {
    bitmap.close();
  }
}
