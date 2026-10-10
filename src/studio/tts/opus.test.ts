import { describe, expect, it } from "vite-plus/test";
import { encodeWavToOggOpus } from "./opus";
import { encodeWavPcm16 } from "./wav";

// The Ogg/Opus muxer and encoder are tested beside them in core oggOpus.test.ts;
// this covers only the WAV-to-Opus step the studio adds on top.
describe("encodeWavToOggOpus", () => {
  it("refuses an empty narration track before reaching the encoder", async () => {
    await expect(encodeWavToOggOpus(encodeWavPcm16(new Int16Array(0), 24_000))).rejects.toThrow(
      "The narration track is empty",
    );
  });
});
