import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { decodeWavPcm16 } from "../tts/wav";
import { decodeFlacToWavPcm16, flacStreamInfoOf } from "./flac";

/** A FLAC file's opening bytes for this sample format; the frames are not needed here. */
function flacHeader(sampleRate: number, channels: number, bitsPerSample: number): Uint8Array {
  const bytes = new Uint8Array(4 + 4 + 34);
  bytes.set([0x66, 0x4c, 0x61, 0x43]); // fLaC
  bytes.set([0x80, 0x00, 0x00, 0x22], 4); // last metadata block, stream info, 34 bytes
  const at = 4 + 4 + 10;
  bytes[at] = sampleRate >> 12;
  bytes[at + 1] = (sampleRate >> 4) & 0xff;
  bytes[at + 2] = ((sampleRate & 0x0f) << 4) | ((channels - 1) << 1) | ((bitsPerSample - 1) >> 4);
  bytes[at + 3] = ((bitsPerSample - 1) & 0x0f) << 4;
  return bytes;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("flacStreamInfoOf", () => {
  it("reads the sample format a FLAC file opens with", () => {
    expect(flacStreamInfoOf(flacHeader(48_000, 1, 16))).toEqual({
      sampleRate: 48_000,
      channels: 1,
      bitsPerSample: 16,
    });
    expect(flacStreamInfoOf(flacHeader(44_100, 2, 24))).toEqual({
      sampleRate: 44_100,
      channels: 2,
      bitsPerSample: 24,
    });
  });

  it("refuses what is not FLAC", () => {
    expect(() => flacStreamInfoOf(new TextEncoder().encode("RIFF....WAVEfmt "))).toThrow(
      "not a FLAC file",
    );
    expect(() => flacStreamInfoOf(new Uint8Array(3))).toThrow("not a FLAC file");
  });
});

describe("decodeFlacToWavPcm16", () => {
  it("refuses a take the browser would resample or downmix without saying so", async () => {
    await expect(decodeFlacToWavPcm16(flacHeader(44_100, 1, 16), 48_000)).rejects.toThrow(
      "expected mono 16-bit 48000 Hz FLAC, got 1 channel(s), 16-bit, 44100 Hz",
    );
    await expect(decodeFlacToWavPcm16(flacHeader(48_000, 2, 16), 48_000)).rejects.toThrow(
      "2 channel(s)",
    );
    await expect(decodeFlacToWavPcm16(flacHeader(48_000, 1, 24), 48_000)).rejects.toThrow("24-bit");
  });

  // Chrome divides positive samples by 32767 and negative ones by 32768 (measured
  // on a real FLAC file); other decoders divide both by 32768.
  it.each([
    ["Chrome's", 0x7fff],
    ["another decoder's", 0x8000],
  ])("turns %s samples back into the 16-bit ones the file holds", async (_name, positiveScale) => {
    const original = Int16Array.from(
      [0, 1, -1, 12_345, -12_345, 16_449, 16_511, 17_267, 0x7fff, -0x8000].concat(
        Array.from({ length: 200 }, (_, index) => 16_000 + index * 37),
      ),
    );
    const decodeAudioData = vi.fn<() => Promise<{ getChannelData: () => Float32Array }>>(
      async () => ({
        getChannelData: () =>
          Float32Array.from(original, (sample) =>
            sample < 0 ? sample / 0x8000 : sample / positiveScale,
          ),
      }),
    );
    const rates: number[] = [];
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData = decodeAudioData;
        constructor(_channels: number, _length: number, sampleRate: number) {
          rates.push(sampleRate);
        }
      },
    );
    // A rate no other test decodes at, so this context is the one built here.
    const rate = positiveScale === 0x7fff ? 32_000 : 16_000;
    const flac = flacHeader(rate, 1, 16);

    const wav = await decodeFlacToWavPcm16(flac, rate);

    expect(decodeWavPcm16(wav)).toEqual({ pcm: original, sampleRate: rate });
    expect(rates).toEqual([rate]);
    // The decoder is handed a copy: it detaches the buffer it is given.
    expect(flac.byteLength).toBe(42);
  });

  it("says so when the browser cannot decode audio", async () => {
    vi.stubGlobal("OfflineAudioContext", undefined);
    await expect(decodeFlacToWavPcm16(flacHeader(22_050, 1, 16), 22_050)).rejects.toThrow(
      "this browser cannot decode FLAC audio",
    );
  });
});
