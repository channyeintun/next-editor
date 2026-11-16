// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createSessionId, parsePreviewOrigin, previewUrl } from "./origin";
import type { PreviewBase } from "./origin";

const DEV: PreviewBase = { protocol: "http:", host: "localhost:5173" };
const PROD: PreviewBase = { protocol: "https:", host: "preview.example.dev" };

describe("preview origins", () => {
  it("builds preview URLs", () => {
    expect(previewUrl(DEV, "k3j2h1", 5173)).toBe("http://k3j2h1-5173.localhost:5173/");
    expect(previewUrl(PROD, "abc123", 3000)).toBe("https://abc123-3000.preview.example.dev/");
    expect(previewUrl({ protocol: "https:", host: "Preview.Example.dev:443" }, "a", 1)).toBe(
      "https://a-1.preview.example.dev/",
    );
  });

  it("rejects bad session ids and ports", () => {
    expect(() => previewUrl(DEV, "Bad", 3000)).toThrow(TypeError);
    expect(() => previewUrl(DEV, "a-b", 3000)).toThrow(TypeError);
    expect(() => previewUrl(DEV, "", 3000)).toThrow(TypeError);
    expect(() => previewUrl(DEV, "abc", 0)).toThrow(RangeError);
    expect(() => previewUrl(DEV, "abc", 65536)).toThrow(RangeError);
    expect(() => previewUrl(DEV, "abc", 1.5)).toThrow(RangeError);
  });

  it("round-trips through parsePreviewOrigin", () => {
    for (const [base, id, port] of [
      [DEV, "k3j2h1", 5173],
      [DEV, "z9", 1],
      [PROD, "abc123", 65535],
    ] as const) {
      const origin = new URL(previewUrl(base, id, port)).origin;
      expect(parsePreviewOrigin(origin, base)).toEqual({ sessionId: id, port });
    }
  });

  it("rejects origins that are not preview origins", () => {
    for (const origin of [
      "http://localhost:5173",
      "http://k3j2h1-5173.localhost:5174",
      "https://k3j2h1-5173.localhost:5173",
      "http://k3j2h1-5173.evil.localhost:5173",
      "http://k3j2h1-5173.localhost:5173/path",
      "http://k3j2h1.localhost:5173",
      "http://k3j2h1-0.localhost:5173",
      "http://k3j2h1-05173.localhost:5173",
      "http://k3j2h1-70000.localhost:5173",
      "http://-5173.localhost:5173",
      "http://a_b-5173.localhost:5173",
      "http://evil.comk3j2h1-5173.localhost:5173",
      "null",
      "not a url",
    ]) {
      expect({ origin, parsed: parsePreviewOrigin(origin, DEV) }).toEqual({ origin, parsed: null });
    }
    expect(parsePreviewOrigin("http://abc-3000.preview.example.dev", PROD)).toBeNull();
  });

  it("mints random lowercase session ids", () => {
    const ids = new Set(Array.from({ length: 200 }, () => createSessionId()));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]{10}$/);
      expect(parsePreviewOrigin(new URL(previewUrl(DEV, id, 80)).origin, DEV)).toEqual({
        sessionId: id,
        port: 80,
      });
    }
  });
});
