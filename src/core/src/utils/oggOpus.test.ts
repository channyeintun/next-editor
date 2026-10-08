import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { encodeMonoPcmToOggOpus, type MonoPcmSource } from "./oggOpus";

// One second of silence at 48 kHz: a single AudioData chunk.
const second: MonoPcmSource = {
  length: 48_000,
  sampleRate: 48_000,
  read: (_offset, frames) => new Float32Array(frames),
};

/**
 * A WebCodecs AudioEncoder that keeps the spec's close semantics: an encoder
 * error closes the codec before the error callback runs, a pending flush()
 * rejects with that error, and close() on a closed codec throws.
 */
const stubWebCodecs = ({ failWith }: { failWith?: DOMException } = {}) => {
  const close = vi.fn<() => void>();

  class FakeAudioData {
    close() {}
  }

  class FakeAudioEncoder {
    static isConfigSupported = async () => ({ supported: true });

    state: CodecState = "unconfigured";
    encodeQueueSize = 0;

    private readonly init: AudioEncoderInit;

    constructor(init: AudioEncoderInit) {
      this.init = init;
    }

    configure() {
      this.state = "configured";
    }

    addEventListener() {}

    encode() {
      queueMicrotask(() => {
        if (failWith) {
          this.state = "closed";
          this.init.error(failWith);
          return;
        }
        const packet = new Uint8Array([0xf8, 0xff, 0xfe]);
        this.init.output(
          {
            byteLength: packet.byteLength,
            copyTo: (destination: Uint8Array) => destination.set(packet),
          } as unknown as EncodedAudioChunk,
          undefined,
        );
      });
    }

    async flush() {
      if (this.state === "closed") throw failWith;
    }

    close() {
      close();
      if (this.state === "closed") {
        throw new DOMException("Cannot call 'close' on a closed codec.", "InvalidStateError");
      }
      this.state = "closed";
    }
  }

  vi.stubGlobal("AudioData", FakeAudioData);
  vi.stubGlobal("AudioEncoder", FakeAudioEncoder);
  return { close };
};

describe("Opus encoding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The error closes the codec, so an unconditional close() in the cleanup
  // threw InvalidStateError and that was logged as why the edit fell back to WAV.
  it("rejects with the encoder's own error, not the cleanup's", async () => {
    const encodingError = new DOMException("Opus encoding failed", "EncodingError");
    stubWebCodecs({ failWith: encodingError });

    await expect(encodeMonoPcmToOggOpus(second)).rejects.toBe(encodingError);
  });

  it("closes the encoder once after a clean run", async () => {
    const { close } = stubWebCodecs();

    const ogg = await encodeMonoPcmToOggOpus(second);

    expect(String.fromCharCode(...ogg.subarray(0, 4))).toBe("OggS");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
