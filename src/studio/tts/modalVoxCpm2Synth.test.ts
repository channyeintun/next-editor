import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { MODAL_VOXCPM2_BURMESE_PROFILE } from "./profiles";
import { synthesizeModalVoxCpm2Wav } from "./modalVoxCpm2Synth";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("synthesizeModalVoxCpm2Wav", () => {
  it("calls only the same-origin Worker route and returns WAV bytes", async () => {
    const wav = new Uint8Array([82, 73, 70, 70]);
    const fetchSpy = vi.fn(async () => {
      return new Response(wav.slice().buffer, {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await synthesizeModalVoxCpm2Wav(MODAL_VOXCPM2_BURMESE_PROFILE, "မင်္ဂလာပါ။", 42);

    expect(result).toEqual(wav);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/studio/tts/voxcpm2",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ text: "မင်္ဂလာပါ။", seed: 42 }),
      }),
    );
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

    await expect(
      synthesizeModalVoxCpm2Wav(MODAL_VOXCPM2_BURMESE_PROFILE, "စာသား", 1),
    ).rejects.toThrow("VoxCPM2 narration: not enabled");
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

    await expect(
      synthesizeModalVoxCpm2Wav(MODAL_VOXCPM2_BURMESE_PROFILE, "စာသား", 1),
    ).rejects.toThrow("non-WAV");
  });
});
