// @vitest-environment node
// The `punycode` builtin against known RFC 3492 / IDNA conversions.
import { describe, expect, it } from "vitest";
import punycode, { decode, encode, toASCII, toUnicode, ucs2 } from "./punycode";

describe("punycode", () => {
  it("has Node's export shape", () => {
    expect(Object.keys(punycode).sort()).toEqual(
      ["decode", "encode", "toASCII", "toUnicode", "ucs2", "version"].sort(),
    );
    expect(typeof punycode.version).toBe("string");
    expect(punycode.encode).toBe(encode);
  });

  it("encodes and decodes labels", () => {
    expect(encode("mañana")).toBe("maana-pta");
    expect(decode("maana-pta")).toBe("mañana");
    expect(encode("☃-⌘")).toBe("--dqo34k");
    expect(decode("--dqo34k")).toBe("☃-⌘");
  });

  it("converts whole domains and email addresses", () => {
    expect(toASCII("mañana.com")).toBe("xn--maana-pta.com");
    expect(toUnicode("xn--maana-pta.com")).toBe("mañana.com");
    expect(toASCII("джумла@джpумлатест.bрфa")).toBe("джумла@xn--p-8sbkgc5ag7bhce.xn--ba-lmcq");
    expect(toASCII("example.com")).toBe("example.com");
  });

  it("converts between UCS-2 and code points", () => {
    expect(ucs2.decode("𝌆")).toEqual([0x1d306]);
    expect(ucs2.encode([0x1d306])).toBe("𝌆");
  });

  it("throws on invalid input", () => {
    expect(() => decode("\x81-")).toThrow(RangeError);
  });
});
