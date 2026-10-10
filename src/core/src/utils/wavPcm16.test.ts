import { describe, expect, it } from "vite-plus/test";
import {
  allocateWavPcm16,
  DATA,
  encodeWavPcm16,
  FMT_,
  readRiffChunks,
  type RiffChunk,
} from "./wavPcm16";

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

const LIST = 0x5453494c; // "LIST" LE

describe("readRiffChunks", () => {
  it("walks the chunks of a written WAV", () => {
    const wav = encodeWavPcm16(Int16Array.from([1, 2, 3]), 24_000);

    expect([...readRiffChunks(viewOf(wav))]).toEqual<RiffChunk[]>([
      { id: FMT_, body: 20, size: 16 },
      { id: DATA, body: 44, size: 6 },
    ]);
  });

  it("steps over the pad byte after an odd-sized chunk", () => {
    const wav = encodeWavPcm16(Int16Array.from([7, -7]), 24_000);
    // fmt, then a 3-byte LIST chunk plus its pad byte, then data.
    const extra = [0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0, 1, 2, 3, 0];
    const bytes = new Uint8Array(wav.length + extra.length);
    bytes.set(wav.subarray(0, 36));
    bytes.set(extra, 36);
    bytes.set(wav.subarray(36), 36 + extra.length);

    expect([...readRiffChunks(viewOf(bytes))]).toEqual<RiffChunk[]>([
      { id: FMT_, body: 20, size: 16 },
      { id: LIST, body: 44, size: 3 },
      { id: DATA, body: 56, size: 4 },
    ]);
  });

  it("reports a size past the end as declared and stops when no header fits", () => {
    const wav = encodeWavPcm16(new Int16Array(4), 24_000);
    const cut = wav.slice(0, 47); // data header plus 3 of its 8 bytes

    expect([...readRiffChunks(viewOf(cut))]).toEqual<RiffChunk[]>([
      { id: FMT_, body: 20, size: 16 },
      { id: DATA, body: 44, size: 8 },
    ]);
  });

  it("refuses anything that is not RIFF/WAVE, before walking", () => {
    const notWav = new TextEncoder().encode("<html>oops</html>");
    expect(() => readRiffChunks(viewOf(notWav))).toThrow("Not a RIFF/WAVE file");
    expect(() => readRiffChunks(viewOf(new Uint8Array(8)))).toThrow("Not a RIFF/WAVE file");
  });
});

describe("allocateWavPcm16", () => {
  it("writes the header encodeWavPcm16 writes, with pcm viewing the data chunk", () => {
    const wav = allocateWavPcm16(3, 24_000);
    wav.pcm.set([1, -2, 3]);

    expect(wav.bytes).toEqual(encodeWavPcm16(Int16Array.from([1, -2, 3]), 24_000));
    expect(wav.pcm.buffer).toBe(wav.bytes.buffer);
  });
});
