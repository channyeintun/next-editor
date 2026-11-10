import { describe, expect, it } from "vite-plus/test";
import { sanitizeReturnTo } from "./google";

describe("sanitizeReturnTo", () => {
  it("keeps same-origin relative paths intact", () => {
    expect(sanitizeReturnTo("/code")).toBe("/code");
    expect(sanitizeReturnTo("/learn/rust?step=2#top")).toBe("/learn/rust?step=2#top");
  });

  it("rejects absolute and protocol-relative URLs", () => {
    expect(sanitizeReturnTo("https://evil.example/")).toBe("/");
    expect(sanitizeReturnTo("//evil.example/")).toBe("/");
  });

  it("rejects backslash forms the WHATWG parser resolves cross-origin", () => {
    // The parser treats `\` as `/` for special schemes, so these used to pass a
    // startsWith("//") guard and still land the victim on another origin.
    for (const value of [
      "/\\evil.example",
      "/\\/evil.example",
      "\\/evil.example",
      "\\\\evil.example",
      "/\t/evil.example",
      "/\n\\evil.example",
    ]) {
      const result = sanitizeReturnTo(value);
      expect(new URL(result, "https://app.invalid").origin).toBe("https://app.invalid");
    }
  });

  // Dot segments resolve away, so these came out of one pass as the
  // protocol-relative "//evil.example": safe only because the callback
  // sanitizes a second time. One pass must already be a same-origin path.
  it("never returns a protocol-relative path after resolving dot segments", () => {
    for (const value of [
      "/.//evil.example",
      "/%2e//evil.example",
      "/..//evil.example",
      "/./\\evil.example",
      "/a/..//evil.example",
    ]) {
      const result = sanitizeReturnTo(value);
      expect(result).not.toMatch(/^[/\\]{2}/);
      expect(new URL(result, "https://app.invalid").origin).toBe("https://app.invalid");
    }
    expect(sanitizeReturnTo("/.//evil.example")).toBe("/");
  });

  it("falls back to / for empty or unparseable input", () => {
    expect(sanitizeReturnTo(undefined)).toBe("/");
    expect(sanitizeReturnTo(null)).toBe("/");
    expect(sanitizeReturnTo("")).toBe("/");
  });
});
