import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SavedCustomVoice } from "./customVoices";
import { modalVoxCpm2BurmeseProfileOf, MODAL_VOXCPM2_BURMESE_PROFILE } from "./profiles";
import { synthesizeModalVoxCpm2Wav } from "./modalVoxCpm2Synth";

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

beforeEach(() => {
  voiceStore.getCustomVoice.mockReset().mockResolvedValue(SAVED_VOICE);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("surfaces the Worker's safe error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: "not enabled" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    await expect(synthesizeModalVoxCpm2Wav(PROFILE, "စာသား", 1)).rejects.toThrow(
      "VoxCPM2 narration: not enabled",
    );
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
