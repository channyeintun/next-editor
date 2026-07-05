// Phone camera photos and screenshots are often several megapixels — far more
// than an aspect-video card thumbnail ever displays — so every raster upload
// is downscaled and re-encoded as a compact JPEG before it reaches R2. SVGs
// pass through unchanged: they're vector, already tiny, and rasterizing one
// would only lose quality for no size benefit.
const MAX_THUMBNAIL_DIMENSION = 640;
const THUMBNAIL_JPEG_QUALITY = 0.85;

export async function resizeThumbnail(file: File): Promise<File> {
  if (file.type === "image/svg+xml") return file;

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

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", THUMBNAIL_JPEG_QUALITY),
    );
    if (!blob) return file;

    const name = `${file.name.replace(/\.[^./]+$/, "")}.jpg`;
    return new File([blob], name, { type: "image/jpeg" });
  } finally {
    bitmap.close();
  }
}
