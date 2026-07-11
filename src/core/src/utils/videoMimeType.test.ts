import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  CAMERA_VIDEO_MIME_TYPES,
  SCREEN_VIDEO_MIME_TYPES,
  getSupportedVideoMimeType,
} from "./videoMimeType";

describe("videoMimeType", () => {
  let originalMediaRecorder: typeof MediaRecorder | undefined;

  beforeEach(() => {
    // Save original MediaRecorder descriptor
    originalMediaRecorder = globalThis.MediaRecorder;
  });

  afterEach(() => {
    // Restore original MediaRecorder
    if (originalMediaRecorder === undefined) {
      delete (globalThis as any).MediaRecorder;
    } else {
      (globalThis as any).MediaRecorder = originalMediaRecorder;
    }
  });

  it("returns empty string when MediaRecorder is undefined", () => {
    delete (globalThis as any).MediaRecorder;
    const result = getSupportedVideoMimeType(CAMERA_VIDEO_MIME_TYPES);
    expect(result).toBe("");
  });

  it("returns the first supported type in probe order", () => {
    // Create a mock MediaRecorder that only supports vp8 variant
    (globalThis as any).MediaRecorder = {
      isTypeSupported: (mimeType: string) => mimeType === "video/webm;codecs=vp8",
    };

    const result = getSupportedVideoMimeType(CAMERA_VIDEO_MIME_TYPES);
    expect(result).toBe("video/webm;codecs=vp8");
  });

  it("returns the earliest supported type when multiple are supported", () => {
    // Create a mock that supports both vp8 and vp9, but vp9 should be tried first
    (globalThis as any).MediaRecorder = {
      isTypeSupported: (mimeType: string) =>
        mimeType === "video/webm;codecs=vp9" || mimeType === "video/webm;codecs=vp8",
    };

    const result = getSupportedVideoMimeType(CAMERA_VIDEO_MIME_TYPES);
    // vp9 comes first in CAMERA_VIDEO_MIME_TYPES
    expect(result).toBe("video/webm;codecs=vp9");
  });

  it("returns empty string when nothing is supported", () => {
    (globalThis as any).MediaRecorder = {
      isTypeSupported: () => false,
    };

    const result = getSupportedVideoMimeType(CAMERA_VIDEO_MIME_TYPES);
    expect(result).toBe("");
  });

  it("SCREEN_VIDEO_MIME_TYPES prefers opus-muxed webm codecs", () => {
    // Only opus variants are supported
    (globalThis as any).MediaRecorder = {
      isTypeSupported: (mimeType: string) => mimeType === "video/webm;codecs=vp9,opus",
    };

    const result = getSupportedVideoMimeType(SCREEN_VIDEO_MIME_TYPES);
    expect(result).toBe("video/webm;codecs=vp9,opus");
  });

  it("SCREEN_VIDEO_MIME_TYPES differs from CAMERA_VIDEO_MIME_TYPES in audio codecs", () => {
    expect(SCREEN_VIDEO_MIME_TYPES[0]).toContain("opus");
    expect(CAMERA_VIDEO_MIME_TYPES[0]).not.toContain("opus");
    expect(SCREEN_VIDEO_MIME_TYPES[1]).toContain("opus");
    expect(CAMERA_VIDEO_MIME_TYPES[1]).not.toContain("opus");
  });
});
