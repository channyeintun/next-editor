import { describe, expect, it } from "vite-plus/test";
import { base64ToBytes, bytesToBase64 } from "./base64";

/** `length` bytes cycling through every byte value. */
function bytesOfLength(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index % 256);
}

describe("base64", () => {
  it.each([0, 1, 0x8000, 0x8000 + 1])("round-trips %i bytes", (length) => {
    const bytes = bytesOfLength(length);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("encodes across a chunk boundary exactly as one unchunked pass would", () => {
    const bytes = bytesOfLength(0x8000 + 3);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    expect(bytesToBase64(bytes)).toBe(btoa(binary));
  });

  it("encodes the standard alphabet with padding", () => {
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]))).toBe("+/8=");
    expect(base64ToBytes("+/8=")).toEqual(new Uint8Array([0xfb, 0xff]));
  });
});
