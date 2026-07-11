/**
 * Shared video MIME type utilities for cross-browser MediaRecorder support.
 *
 * Callers pass a probe list (camera vs screen differ only in audio codecs).
 * Priority order is intentional: probe for high-efficiency codecs first, then fallbacks.
 *
 *  - Camera: no audio track, so webm entries list video codecs only
 *  - Screen: muxes narration audio, so webm entries add opus codec
 */

export const CAMERA_VIDEO_MIME_TYPES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4",
] as const;

export const SCREEN_VIDEO_MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
] as const;

/**
 * Returns the best video MIME type supported by the current browser's
 * MediaRecorder implementation from the provided list, or an empty string if none is available.
 */
export const getSupportedVideoMimeType = (mimeTypes: readonly string[]): string => {
  if (typeof MediaRecorder === "undefined") {
    return "";
  }

  for (const mimeType of mimeTypes) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }

  return "";
};
