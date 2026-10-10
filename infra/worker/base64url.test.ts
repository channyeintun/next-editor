import { describe, expect, it } from "vite-plus/test";
import { base64UrlDecodeToBytes, base64UrlEncode, randomBase64Url } from "./base64url";

describe("base64url", () => {
  it("uses the URL-safe alphabet without padding", () => {
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xef, 0xff]).buffer)).toBe("--__");
    expect(base64UrlEncode(new Uint8Array())).toBe("");
  });

  it("round-trips every length across a padding cycle", () => {
    for (let length = 0; length <= 9; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 97 + 251) % 256);
      const encoded = base64UrlEncode(bytes);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(base64UrlDecodeToBytes(encoded)).toEqual(bytes);
    }
  });

  it("decodes an unpadded JWT segment", () => {
    expect(new TextDecoder().decode(base64UrlDecodeToBytes("eyJhbGciOiJSUzI1NiJ9"))).toBe(
      '{"alg":"RS256"}',
    );
  });

  it("encodes the requested number of random bytes", () => {
    const token = randomBase64Url(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(base64UrlDecodeToBytes(token)).toHaveLength(32);
  });
});
