import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { measureAudioDurationSeconds } from "./audioDuration";

type DecodeResult = { duration: number } | Error;

const stubOfflineAudioContext = (decode: (bytes: ArrayBuffer) => DecodeResult) => {
  const sampleRates: number[] = [];
  class FakeOfflineAudioContext {
    constructor(_channels: number, _length: number, sampleRate: number) {
      sampleRates.push(sampleRate);
    }

    decodeAudioData(
      bytes: ArrayBuffer,
      onSuccess?: (buffer: { duration: number }) => void,
      onError?: (error: Error) => void,
    ): Promise<{ duration: number }> {
      const result = decode(bytes);
      if (result instanceof Error) {
        onError?.(result);
        return Promise.reject(result);
      }
      onSuccess?.(result);
      return Promise.resolve(result);
    }
  }
  vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
  return sampleRates;
};

describe("audio duration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Decoding resamples the whole file to the context's rate as Float32 just to read
  // one number, so a realtime 48 kHz context held ~230 MB for 20 minutes of mono
  // narration, and creating one before a user gesture trips the autoplay policy.
  it("decodes on a low-rate offline context, never a realtime one", async () => {
    const realtimeContext = vi.fn<() => void>();
    vi.stubGlobal("AudioContext", realtimeContext);
    const sampleRates = stubOfflineAudioContext((bytes) => ({
      duration: bytes.byteLength / 100,
    }));

    const duration = await measureAudioDurationSeconds(new Blob([new Uint8Array(250)]));

    expect(duration).toBe(2.5);
    expect(realtimeContext).not.toHaveBeenCalled();
    expect(sampleRates).toHaveLength(1);
    expect(sampleRates[0]).toBeLessThanOrEqual(8000);
  });

  // iOS WebKit plays audio/mp4 it cannot decode through Web Audio.
  it("reads the media element's duration when decoding fails", async () => {
    stubOfflineAudioContext(() => new Error("EncodingError"));
    class FakeAudio extends EventTarget {
      src = "";
      duration = Number.NaN;
      load() {
        this.duration = 3.25;
        this.dispatchEvent(new Event("loadedmetadata"));
      }
    }
    vi.stubGlobal("Audio", FakeAudio);

    await expect(measureAudioDurationSeconds(new Blob([new Uint8Array(4)]))).resolves.toBe(3.25);
  });
});
