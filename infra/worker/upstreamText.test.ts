import { describe, expect, it } from "vite-plus/test";
import { sanitizeUpstreamText } from "./upstreamText";

const TOKEN_PATTERN = /\btok-[a-z0-9]{6,}\b/g;

describe("sanitizeUpstreamText", () => {
  it("redacts the secrets and anything secret-shaped, then flattens the text", () => {
    expect(
      sanitizeUpstreamText("  bad key s3cret\n\tfrom host.example and tok-abc123\u001b[0m ", {
        secrets: ["s3cret", "host.example"],
        secretPattern: TOKEN_PATTERN,
        maxChars: 200,
      }),
    ).toBe("bad key [redacted] from [redacted] and [redacted] [0m");
  });

  it("skips an empty secret instead of redacting between every character", () => {
    expect(
      sanitizeUpstreamText("plain message", {
        secrets: [""],
        secretPattern: TOKEN_PATTERN,
        maxChars: 200,
      }),
    ).toBe("plain message");
  });

  it("cuts an over-long result to maxChars with a trailing ellipsis", () => {
    const options = { secrets: [], secretPattern: TOKEN_PATTERN, maxChars: 10 };

    expect(sanitizeUpstreamText("abcdefghij", options)).toBe("abcdefghij");
    expect(sanitizeUpstreamText("abcdefghijk", options)).toBe("abcdefghi…");
  });

  it("returns null when nothing but control characters and whitespace is left", () => {
    expect(
      sanitizeUpstreamText(" \n\u0000\t ", {
        secrets: ["x"],
        secretPattern: TOKEN_PATTERN,
        maxChars: 200,
      }),
    ).toBeNull();
  });
});
