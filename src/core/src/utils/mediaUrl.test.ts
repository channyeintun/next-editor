import { describe, expect, it } from "vitest";
import { allowedRecordingMediaUrl, isAllowedRecordingMediaUrl } from "./mediaUrl";

describe("recording media URL guard", () => {
  it("allows the schemes real recordings use", () => {
    for (const url of [
      "https://cdn.example/lesson.ogg",
      "http://localhost:5173/lesson.ogg",
      "blob:https://app.example/6f0d-1",
      "/media/lessons/abc/abc.ogg",
    ]) {
      expect(isAllowedRecordingMediaUrl(url)).toBe(true);
      expect(allowedRecordingMediaUrl(url)).toBe(url);
    }
  });

  it("rejects non-network schemes and junk", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "",
      null,
      undefined,
    ]) {
      expect(isAllowedRecordingMediaUrl(url)).toBe(false);
      expect(allowedRecordingMediaUrl(url)).toBeNull();
    }
  });
});
