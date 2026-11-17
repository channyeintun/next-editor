// @vitest-environment node
// Differential tests: the `string_decoder` builtin against Node's own.
import { StringDecoder as NodeStringDecoderClass } from "node:string_decoder";
import { describe, expect, it } from "vitest";
import stringDecoder, { StringDecoder } from "./string_decoder";

/**
 * Node's StringDecoder as it behaves at runtime: @types/node narrows the
 * constructor to `BufferEncoding` and omits the `encoding` field.
 */
const NodeStringDecoder = NodeStringDecoderClass as unknown as new (
  encoding?: string,
) => NodeStringDecoderClass & { encoding: string };

const euro = Buffer.from("€");
const emoji = Buffer.from("😀");

/** Writes each chunk then ends, collecting every output. */
function decodeChunks(
  Decoder: new (encoding?: string) => { write(b: Uint8Array): string; end(): string },
  encoding: string,
  chunks: Uint8Array[],
): string[] {
  const decoder = new Decoder(encoding);
  return [...chunks.map((chunk) => decoder.write(chunk)), decoder.end()];
}

describe("string_decoder", () => {
  it("has Node's export shape", () => {
    expect(Object.keys(stringDecoder)).toEqual(["StringDecoder"]);
    expect(stringDecoder.StringDecoder).toBe(StringDecoder);
    expect(new StringDecoder().encoding).toBe("utf8");
  });

  const cases: [string, Uint8Array[]][] = [
    ["utf8", [euro.subarray(0, 1), euro.subarray(1)]],
    ["utf8", [emoji.subarray(0, 2), emoji.subarray(2, 3), emoji.subarray(3)]],
    ["utf8", [emoji.subarray(0, 3)]],
    ["utf8", [Buffer.from([0xff, 0x41])]],
    ["utf8", [Buffer.from("plain ascii")]],
    [
      "utf16le",
      [Buffer.from("hé", "utf16le").subarray(0, 3), Buffer.from("hé", "utf16le").subarray(3)],
    ],
    ["base64", [Buffer.from("abcd").subarray(0, 1), Buffer.from("abcd").subarray(1)]],
    ["hex", [Buffer.from([1, 2, 255])]],
    ["latin1", [Buffer.from([0xe9, 0x41])]],
    ["ascii", [Buffer.from("abc")]],
  ];

  it.each(cases)("decodes %s chunks as Node does", (encoding, chunks) => {
    expect(decodeChunks(StringDecoder, encoding, chunks)).toEqual(
      decodeChunks(NodeStringDecoder, encoding, chunks),
    );
  });

  it("normalizes encoding names", () => {
    expect(new StringDecoder("UTF-8").encoding).toBe(new NodeStringDecoder("UTF-8").encoding);
    expect(new StringDecoder("ucs2").encoding).toBe(new NodeStringDecoder("ucs2").encoding);
    expect(() => new StringDecoder("nope")).toThrow(/Unknown encoding: nope/);
  });

  /** Runs `fn` with a decoder class; the result, or the error's name, code and message. */
  function outcome(fn: (D: typeof NodeStringDecoder) => unknown) {
    return (D: typeof NodeStringDecoder) => {
      try {
        return fn(D);
      } catch (error) {
        const e = error as Error & { code?: string };
        return { name: e.name, code: e.code, message: e.message };
      }
    };
  }

  const behaviours: [string, (D: typeof NodeStringDecoder) => unknown][] = [
    ["a plain Uint8Array", (D) => new D("utf8").write(new Uint8Array([104, 105]))],
    ["a plain Uint8Array as hex", (D) => new D("hex").write(new Uint8Array([104, 105]))],
    [
      "a character split across Uint8Arrays",
      (D) => {
        const d = new D("utf8");
        return d.write(new Uint8Array([0x68, 0xc3])) + d.write(new Uint8Array([0xa9]));
      },
    ],
    ["a Uint16Array", (D) => new D("utf8").write(new Uint16Array([0x6968]) as never)],
    [
      "a DataView",
      (D) => new D("utf8").write(new DataView(new TextEncoder().encode("hi").buffer) as never),
    ],
    ["an ArrayBuffer", (D) => new D("utf8").write(new Uint8Array(2).buffer as never)],
    ["a number", (D) => new D("utf8").write(5 as never)],
    ["null", (D) => new D("utf8").write(null as never)],
    ["end with a number", (D) => new D("utf8").end(5 as never)],
    ["end with a string", (D) => new D("utf8").end("abc")],
    ["a string", (D) => new D("utf8").write("abc")],
    ["an unknown encoding's error", (D) => new D("nope")],
    [
      "base64url",
      (D) => {
        const d = new D("base64url");
        return [
          d.encoding,
          d.write(Buffer.from([0xfb, 0xff])),
          d.end(),
          d.write(Buffer.from([0xfb, 0xff, 0xbf, 1])),
          d.end(),
        ];
      },
    ],
    ["BASE64URL", (D) => new D("BASE64URL").encoding],
    [
      "utf8 after end()",
      (D) => {
        const d = new D("utf8");
        return [
          d.write(Buffer.from([0xe2])),
          d.end(),
          d.write(Buffer.from("A")),
          d.write(Buffer.from([0xe2])),
          d.end(),
          d.write(Buffer.from([0xff, 0x41])),
        ];
      },
    ],
    [
      "base64 after end()",
      (D) => {
        const d = new D("base64");
        return [d.write(Buffer.from([1])), d.end(), d.write(Buffer.from([2])), d.end()];
      },
    ],
    [
      "utf16le after end()",
      (D) => {
        const d = new D("utf16le");
        return [d.write(Buffer.from([0x41])), d.end(), d.write(Buffer.from([0x42, 0])), d.end()];
      },
    ],
    [
      "the partial-character fields",
      (D) => {
        const d = new D("utf8");
        d.write(Buffer.from([0xe2]));
        const d2 = d as unknown as { lastNeed: number; lastTotal: number; lastChar: Uint8Array };
        return [d2.lastNeed, d2.lastTotal, [...d2.lastChar], Object.keys(d)];
      },
    ],
  ];

  it.each(behaviours)("handles %s as Node does", (_label, fn) => {
    expect(outcome(fn)(StringDecoder as unknown as typeof NodeStringDecoder)).toEqual(
      outcome(fn)(NodeStringDecoder),
    );
  });
});
