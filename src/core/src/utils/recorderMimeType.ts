/**
 * MediaRecorder MIME types for each recorder, in the order it probes them: the most
 * efficient codecs first, then fallbacks.
 */

/**
 *  1. audio/webm (Opus) – best quality/size for Chrome & Brave
 *  2. audio/mp4 (AAC)   – only format supported by iOS WebKit 14.3+
 *  3. audio/ogg         – Firefox fallback
 *  4. audio/wav / mpeg  – last-resort probes; no current browser's MediaRecorder
 *                         reports either
 */
export const AUDIO_MIME_TYPES = [
  "audio/webm; codecs=opus",
  "audio/webm",
  "audio/mp4; codecs=mp4a.40.2",
  "audio/mp4",
  "audio/ogg; codecs=opus",
  "audio/ogg",
  "audio/wav",
  "audio/mpeg",
] as const;

/** The camera track has no audio, so its webm entries list video codecs only. */
export const CAMERA_VIDEO_MIME_TYPES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4",
] as const;

/** A screen recording muxes the narration, so its webm entries add the opus codec. */
export const SCREEN_VIDEO_MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
] as const;

/**
 * The first of `mimeTypes` this browser's MediaRecorder supports, or an empty string
 * when there is no MediaRecorder or it supports none of them.
 */
export const getSupportedRecorderMimeType = (mimeTypes: readonly string[]): string => {
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
