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
 * Format: `screen-recording-YYYYMMDD-HHmmss[-silent].<ext>`
 *
 * A silent recording (no audio track — the browser returned no display/tab audio and no
 * microphone was mixed) is marked with a `-silent` suffix so the downloaded file itself is
 * honest about missing narration.
 *
 * @param mimeType MIME type of the video (e.g., "video/webm", "video/mp4;codecs=avc1")
 * @param now Optional Date object; defaults to current time. Useful for testing.
 * @param hasAudio Whether the video carries an audio track; false appends `-silent`.
 * @returns Filename with zero-padded date/time and extension from cameraExtensionFromMime.
 */
export function screenRecordingFilename(
  mimeType: string,
  now: Date = new Date(),
  hasAudio = true,
): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");

  const ext = cameraExtensionFromMime(mimeType);
  const suffix = hasAudio ? "" : "-silent";
  return `screen-recording-${year}${month}${day}-${hours}${minutes}${seconds}${suffix}.${ext}`;
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
  hasAudio = true,
}: {
  blob: Blob;
  mimeType: string;
  /** False when the capture produced no audio track; marks the file `-silent` and warns. */
  hasAudio?: boolean;
}): void {
  if (!hasAudio) {
    console.warn(
      'saveScreenRecordingLocally: no audio track — saving a silent video ("…-silent"). ' +
        'To include narration, share a browser tab with "share tab audio" enabled.',
    );
  }
  const filename = screenRecordingFilename(mimeType, new Date(), hasAudio);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
