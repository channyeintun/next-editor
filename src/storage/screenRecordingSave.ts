/**
 * Local-only exit path for screen-recording video blobs.
 *
 * This module is the sole and intentional exit path for screen-recording video bytes.
 * The screen-recording video blob:
 * - Must never enter the `Recording` type
 * - Must never be serialized into the `.ne` stream codec
 * - Must never be stored in IndexedDB
 * - Must never be included in any publish or upload payload
 *
 * It exits solely through `saveScreenRecordingLocally()` as a browser download.
 */

import { cameraExtensionFromMime } from "./streamingRecordingCodec/format";

/**
 * Generate a screen-recording filename using local time.
 * Format: `screen-recording-YYYYMMDD-HHmmss.<ext>`
 *
 * @param mimeType MIME type of the video (e.g., "video/webm", "video/mp4;codecs=avc1")
 * @param now Optional Date object; defaults to current time. Useful for testing.
 * @returns Filename with zero-padded date/time and extension from cameraExtensionFromMime.
 */
export function screenRecordingFilename(mimeType: string, now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");

  const ext = cameraExtensionFromMime(mimeType);
  return `screen-recording-${year}${month}${day}-${hours}${minutes}${seconds}.${ext}`;
}

/**
 * Save a screen-recording video blob locally as a browser download.
 * The blob is not retained in memory, storage, or any recording metadata.
 *
 * @param options Object containing:
 *   - blob: The video Blob to download
 *   - mimeType: MIME type of the video
 */
export function saveScreenRecordingLocally({
  blob,
  mimeType,
}: {
  blob: Blob;
  mimeType: string;
}): void {
  const filename = screenRecordingFilename(mimeType);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
