import { MAX_THUMBNAIL_BYTES } from "../../lessons/uploadLimits";
import { resizeThumbnail } from "./resizeThumbnail";
import { THUMBNAIL_MIME_TYPES } from "./thumbnailConstraints";

export type PreparedThumbnail = { file: File } | { error: string };

/**
 * Checks a picked thumbnail and downscales it for upload, or says why it
 * can't be used. Shared by the upload modal and My Library's thumbnail
 * change, so both pickers accept the same files with the same messages.
 */
export async function prepareThumbnail(file: File): Promise<PreparedThumbnail> {
  if (!THUMBNAIL_MIME_TYPES.includes(file.type)) {
    return { error: "Choose a PNG or JPG image." };
  }
  if (file.size > MAX_THUMBNAIL_BYTES) {
    return { error: `Image is too large — ${MAX_THUMBNAIL_BYTES / (1024 * 1024)}MB max.` };
  }
  // Downscaled/re-encoded here, before it ever touches state or an upload —
  // the raw camera-resolution file is never what gets previewed or stored.
  // The guards above only read `type` and `size`, so a corrupt or renamed
  // non-image reaches `createImageBitmap` and rejects; without this catch the
  // picker just goes dead with nothing shown.
  try {
    return { file: await resizeThumbnail(file) };
  } catch {
    return { error: "Couldn't read that image — try a different file." };
  }
}
