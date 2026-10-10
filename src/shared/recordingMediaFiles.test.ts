import { describe, expect, it } from "vite-plus/test";
import {
  AUDIO_MIME_BY_EXT,
  audioExtensionFromMime,
  audioMimeFromFilename,
  CAMERA_MIME_BY_EXT,
  cameraExtensionFromMime,
  cameraMimeFromFilename,
  DEFAULT_AUDIO_EXTENSION,
  DEFAULT_CAMERA_EXTENSION,
  isRecordingAudioFileName,
  isRecordingVideoFileName,
  RECORDING_IMPORT_ACCEPT,
} from "./recordingMediaFiles";

describe("recording media files", () => {
  it("builds the import picker's accept list from the tables", () => {
    expect(RECORDING_IMPORT_ACCEPT).toBe(
      ".ne,.webm,.mp4,.mov,video/*,.weba,.ogg,.m4a,.mp3,.wav,audio/*",
    );
  });

  it("tells narration and camera files apart by extension, in any case", () => {
    for (const name of ["a.weba", "a.ogg", "a.m4a", "a.mp3", "a.wav", "A.WEBA", "take.Mp3"]) {
      expect(isRecordingAudioFileName(name)).toBe(true);
      expect(isRecordingVideoFileName(name)).toBe(false);
    }
    for (const name of ["a.webm", "a.mp4", "a.mov", "A.WEBM", "take.MoV"]) {
      expect(isRecordingVideoFileName(name)).toBe(true);
      expect(isRecordingAudioFileName(name)).toBe(false);
    }
    for (const name of ["a.ne", "a.png", "weba", "a.weba.txt", "a.webmx"]) {
      expect(isRecordingAudioFileName(name)).toBe(false);
      expect(isRecordingVideoFileName(name)).toBe(false);
    }
  });

  it("falls back to WebM containers, with .weba for audio", () => {
    expect(DEFAULT_CAMERA_EXTENSION).toBe("webm");
    expect(DEFAULT_AUDIO_EXTENSION).toBe("weba");
    expect(CAMERA_MIME_BY_EXT[DEFAULT_CAMERA_EXTENSION]).toBe("video/webm");
    expect(AUDIO_MIME_BY_EXT[DEFAULT_AUDIO_EXTENSION]).toBe("audio/webm");
    expect(cameraExtensionFromMime(undefined)).toBe("webm");
    expect(cameraExtensionFromMime("video/x-unknown")).toBe("webm");
    expect(audioExtensionFromMime(undefined)).toBe("weba");
    expect(audioExtensionFromMime("audio/x-unknown")).toBe("weba");
  });

  it("maps MIME types to extensions, ignoring parameters and case", () => {
    expect(cameraExtensionFromMime("video/mp4;codecs=avc1")).toBe("mp4");
    expect(cameraExtensionFromMime("Video/QuickTime")).toBe("mov");
    expect(audioExtensionFromMime("audio/webm;codecs=opus")).toBe("weba");
    expect(audioExtensionFromMime("audio/mpeg")).toBe("mp3");
  });

  it("maps filenames to MIME types, and nothing for an unknown or missing extension", () => {
    expect(cameraMimeFromFilename("take.MOV")).toBe("video/quicktime");
    expect(audioMimeFromFilename("take.m4a")).toBe("audio/mp4");
    expect(audioMimeFromFilename("take.webm")).toBeUndefined();
    expect(cameraMimeFromFilename(undefined)).toBeUndefined();
    expect(audioMimeFromFilename("take.constructor")).toBeUndefined();
  });
});
