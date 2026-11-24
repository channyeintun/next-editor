// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isLoopbackHost, isLoopbackUrl, publishedIndexUrl, studioPageUrl } from "./site.ts";

describe("site", () => {
  it("counts only this machine's names as loopback", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "studio.localhost",
      "127.0.0.1",
      "127.1.2.3",
      "[::1]",
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of [
      "nexteditor.dev",
      "localhost.example.com",
      "128.0.0.1",
      "10.0.0.1",
      "127.0.0.1.evil.dev",
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
    expect(isLoopbackUrl("http://[::1]:5173")).toBe(true);
    expect(isLoopbackUrl("https://nexteditor.dev")).toBe(false);
  });

  it("opens the bare studio page and reads the index the studio reads", () => {
    expect(studioPageUrl("https://nexteditor.dev")).toBe("https://nexteditor.dev/studio");
    expect(publishedIndexUrl("http://localhost:5173")).toBe(
      "http://localhost:5173/api/studio/scripts/index",
    );
  });
});
