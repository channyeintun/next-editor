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
});
