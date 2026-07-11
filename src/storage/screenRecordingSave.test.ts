import { describe, expect, it } from "vite-plus/test";
import { screenRecordingFilename } from "./screenRecordingSave";

describe("screenRecordingFilename", () => {
  it("formats date/time with zero-padded components", () => {
    const testDate = new Date(2026, 6, 12, 9, 5, 3); // July 12, 2026, 09:05:03
    const filename = screenRecordingFilename("video/webm", testDate);
    expect(filename).toBe("screen-recording-20260712-090503.webm");
  });

  it("handles mp4 MIME type", () => {
    const testDate = new Date(2026, 0, 15, 14, 30, 45); // Jan 15, 2026, 14:30:45
    const filename = screenRecordingFilename("video/mp4", testDate);
    expect(filename).toBe("screen-recording-20260115-143045.mp4");
  });

  it("strips MIME type parameters after semicolon", () => {
    const testDate = new Date(2026, 11, 31, 23, 59, 59); // Dec 31, 2026, 23:59:59
    const filename = screenRecordingFilename("video/mp4;codecs=avc1", testDate);
    expect(filename).toBe("screen-recording-20261231-235959.mp4");
  });

  it("defaults to .webm for unknown MIME type", () => {
    const testDate = new Date(2026, 5, 1, 12, 0, 0); // June 1, 2026, 12:00:00
    const filename = screenRecordingFilename("video/unknown-codec", testDate);
    expect(filename).toBe("screen-recording-20260601-120000.webm");
  });

  it("defaults to .webm for empty MIME type", () => {
    const testDate = new Date(2026, 3, 10, 8, 15, 30); // April 10, 2026, 08:15:30
    const filename = screenRecordingFilename("", testDate);
    expect(filename).toBe("screen-recording-20260410-081530.webm");
  });

  it("handles quicktime/mov extension", () => {
    const testDate = new Date(2026, 2, 20, 16, 45, 20); // March 20, 2026, 16:45:20
    const filename = screenRecordingFilename("video/quicktime", testDate);
    expect(filename).toBe("screen-recording-20260320-164520.mov");
  });
});
