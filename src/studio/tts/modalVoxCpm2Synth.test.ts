import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SavedCustomVoice } from "./customVoices";
import { modalVoxCpm2BurmeseProfileOf, MODAL_VOXCPM2_BURMESE_PROFILE } from "./profiles";
import { synthesizeModalVoxCpm2Wav, voxCpm2SynthProvider } from "./modalVoxCpm2Synth";

const voiceStore = vi.hoisted(() => ({
  getCustomVoice: vi.fn<(id: string) => Promise<SavedCustomVoice | null>>(),
}));

vi.mock("./customVoices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./customVoices")>();
  return { ...actual, getCustomVoice: voiceStore.getCustomVoice };
});

const SAVED_VOICE: SavedCustomVoice = {
  id: "voice-1",
  name: "Narrator",
  createdAtIso: "2026-07-27T00:00:00.000Z",
  sampleRate: 24_000,
  samples: new Float32Array(24_000 * 5),
  sampleSha256: "a".repeat(64),
};
const PROFILE = modalVoxCpm2BurmeseProfileOf(SAVED_VOICE);

type FetchMock = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

beforeEach(() => {
  voiceStore.getCustomVoice.mockReset().mockResolvedValue(SAVED_VOICE);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function wavResponse(): Response {
  return new Response(new Uint8Array([82, 73, 70, 70]).buffer, {
    status: 200,
    headers: { "Content-Type": "audio/wav" },
  });
}

describe("synthesizeModalVoxCpm2Wav", () => {
  it("calls only the same-origin Worker route and returns WAV bytes", async () => {
    const wav = new Uint8Array([82, 73, 70, 70]);
    const fetchSpy = vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(async () => {
      return new Response(wav.slice().buffer, {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await synthesizeModalVoxCpm2Wav(PROFILE, "မင်္ဂလာပါ။", 42);

    expect(result).toEqual(wav);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/studio/tts/voxcpm2");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(payload.text).toBe("မင်္ဂလာပါ။");
    expect(payload.seed).toBe(42);
    expect(typeof payload.referenceAudioBase64).toBe("string");
    expect(atob(String(payload.referenceAudioBase64)).slice(0, 4)).toBe("RIFF");
  });

  it("requires a browser-local reference voice", async () => {
    await expect(
      synthesizeModalVoxCpm2Wav(MODAL_VOXCPM2_BURMESE_PROFILE, "စာသား", 1),
    ).rejects.toThrow("requires a recorded reference voice");
  });

  it("surfaces the Worker's safe error message without retrying", async () => {
    const fetchSpy = vi.fn<FetchMock>(async () => {
      return new Response(JSON.stringify({ error: "not enabled" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(synthesizeModalVoxCpm2Wav(PROFILE, "စာသား", 1)).rejects.toThrow(
      "VoxCPM2 narration: not enabled",
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("retries a dropped connection with the same request", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .fn<FetchMock>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(wavResponse());
    vi.stubGlobal("fetch", fetchSpy);

    const result = synthesizeModalVoxCpm2Wav(PROFILE, "စာသား", 1);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual(new Uint8Array([82, 73, 70, 70]));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][1]?.body).toBe(fetchSpy.mock.calls[0][1]?.body);
  });

  it("gives up after three dropped connections", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn<FetchMock>(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);

    // Settle into a value first: a bare rejection would go unhandled while the
    // fake timers run the retry delays.
    const failure = synthesizeModalVoxCpm2Wav(PROFILE, "စာသား", 1).catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(((await failure) as Error).message).toBe(
      "VoxCPM2 narration: the connection failed 3 times (Failed to fetch)",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("rejects a successful non-WAV response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response("not audio", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }),
    );

    await expect(synthesizeModalVoxCpm2Wav(PROFILE, "စာသား", 1)).rejects.toThrow("non-WAV");
  });
});

describe("voxCpm2SynthProvider", () => {
  it("sends the script's seed and makes no request to preload", async () => {
    const fetchSpy = vi.fn<FetchMock>(async () => wavResponse());
    vi.stubGlobal("fetch", fetchSpy);

    const provider = voxCpm2SynthProvider(PROFILE, 42);

    expect(provider).toMatchObject({
      sampleRate: PROFILE.sampleRate,
      mimeType: PROFILE.mimeType,
      seed: 42,
    });
    await provider.preload();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await provider.synthesize("စာသား")).hitFrameCap).toBe(false);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)).seed).toBe(42);
  });
});
