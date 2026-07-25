import { describe, expect, it } from "vitest";
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

  it("falls back to / for empty or unparseable input", () => {
    expect(sanitizeReturnTo(undefined)).toBe("/");
    expect(sanitizeReturnTo(null)).toBe("/");
    expect(sanitizeReturnTo("")).toBe("/");
  });
});
