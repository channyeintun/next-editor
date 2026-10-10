import { describe, expect, it } from "vite-plus/test";
import { sha256Hex } from "./sha256Hex";

// SHA-256("abc"), FIPS 180-2 appendix B.1.
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("sha256Hex", () => {
  it("hashes the UTF-8 bytes to lowercase hex", async () => {
    await expect(sha256Hex("")).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    await expect(sha256Hex("abc")).resolves.toBe(ABC_SHA256);
  });

  it("hashes a view and an ArrayBuffer like the string they encode", async () => {
    const bytes = new TextEncoder().encode("abc");
    expect(await sha256Hex(bytes)).toBe(ABC_SHA256);
    expect(await sha256Hex(bytes.slice())).toBe(ABC_SHA256);
    expect(await sha256Hex(bytes.buffer)).toBe(ABC_SHA256);
  });

  it("hashes only the view's window of a larger buffer", async () => {
    const buffer = new Uint8Array([0xff, 0x61, 0x62, 0x63, 0xff]);
    expect(await sha256Hex(buffer.subarray(1, 4))).toBe(ABC_SHA256);
  });

  it.skipIf(typeof SharedArrayBuffer === "undefined")(
    "hashes a SharedArrayBuffer-backed view like its copy",
    async () => {
      const shared = new Uint8Array(new SharedArrayBuffer(5));
      shared.set(new TextEncoder().encode("xabcx"));
      expect(await sha256Hex(shared.subarray(1, 4))).toBe(ABC_SHA256);
    },
  );
});
