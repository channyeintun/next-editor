// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodeHtmlBody } from "./htmlInject";

function latin1Bytes(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

describe("decodeHtmlBody", () => {
  it("takes the encoding from <meta charset> when the header names none", async () => {
    const bytes = latin1Bytes('<meta charset="windows-1252"><p>caf\xe9</p>');
    expect(await decodeHtmlBody(bytes, [["Content-Type", "text/html"]])).toContain("café");
  });

  it("takes it from a http-equiv Content-Type too", async () => {
    const bytes = latin1Bytes(
      '<head><meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1"></head>\xe9',
    );
    expect(await decodeHtmlBody(bytes, [["Content-Type", "text/html"]])).toContain("é");
  });

  it("lets the header's charset win over a meta", async () => {
    const bytes = new TextEncoder().encode('<meta charset="windows-1252"><p>café</p>');
    expect(await decodeHtmlBody(bytes, [["Content-Type", "text/html; charset=utf-8"]])).toContain(
      "café",
    );
  });

  it("reads a byte order mark before anything else", async () => {
    const bytes = Uint8Array.from([0xff, 0xfe, 0x68, 0x00, 0xe9, 0x00]);
    expect(await decodeHtmlBody(bytes, [["Content-Type", "text/html; charset=windows-1252"]])).toBe(
      "hé",
    );
  });

  it("decodes UTF-8 when nothing names an encoding", async () => {
    const bytes = new TextEncoder().encode("<p>café</p>");
    expect(await decodeHtmlBody(bytes, [["Content-Type", "text/html"]])).toBe("<p>café</p>");
  });
});
