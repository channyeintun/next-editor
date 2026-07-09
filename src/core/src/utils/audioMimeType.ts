/**
 * Shared audio MIME type utilities for cross-browser MediaRecorder support.
 *
 * Priority order is intentional:
 *  1. audio/webm (Opus) – best quality/size for Chrome & Brave
 *  2. audio/mp4 (AAC)   – only format supported by iOS WebKit 14.3+
 *  3. audio/ogg         – Firefox fallback
 *  4. audio/wav / mpeg  – last-resort, universally readable
 */

const AUDIO_MIME_TYPE_PRIORITY = [
  "audio/webm; codecs=opus",
  "audio/webm",
  "audio/mp4; codecs=mp4a.40.2",
  "audio/mp4",
  "audio/ogg; codecs=opus",
  "audio/ogg",
  "audio/wav",
  "audio/mpeg",
] as const;

/**
 * Returns the best audio MIME type supported by the current browser's
 * MediaRecorder implementation, or an empty string if none is available.
 */
export const getSupportedAudioMimeType = (): string => {
  if (typeof MediaRecorder === "undefined") {
    return "";
  }

  for (const mimeType of AUDIO_MIME_TYPE_PRIORITY) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }

  return "";
};

/**
 * Returns true if audio recording is supported in the current browser.
 *
 * Checks:
 *  - `MediaRecorder` API is present (absent on iOS WebKit < 14.3 and some
 *    non-Chromium environments)
 *  - At least one audio MIME type is accepted by `MediaRecorder.isTypeSupported`
 *
 * Use this guard before attempting to call `getUserMedia` so that unsupported
 * environments receive a clear, early error instead of a silent failure.
 */
export const isAudioRecordingSupported = (): boolean => {
  return getSupportedAudioMimeType() !== "";
};
