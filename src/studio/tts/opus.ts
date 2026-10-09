import { decodeWavPcm16 } from "./wav";
import { encodeMonoPcmToOggOpus } from "../../core/src/utils/oggOpus";

// The Ogg/Opus encoder lives in core, where recorded narration uses it too.
export { muxOggOpus, oggCrc32, OGG_OPUS_MIME } from "../../core/src/utils/oggOpus";

/**
 * Transcode a stitched PCM16 mono WAV narration track into Ogg/Opus.
 *
 * Synthesis works in PCM16 WAV because stitching dialogs at exact sample
 * offsets has to stay a byte-level operation (see wav.ts); this is the step
 * that makes the published artifact small.
 */
export async function encodeWavToOggOpus(
  wavBytes: Uint8Array,
  options: { bitrate?: number; signal?: AbortSignal } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const { pcm, sampleRate } = decodeWavPcm16(wavBytes);
  if (pcm.length === 0) {
    throw new Error("The narration track is empty");
  }

  return encodeMonoPcmToOggOpus(
    {
      length: pcm.length,
      sampleRate,
      // Converted a second at a time, as the samples reach the encoder.
      read: (offset, frames) => {
        const samples = new Float32Array(frames);
        for (let index = 0; index < frames; index++) {
          samples[index] = pcm[offset + index] / 0x8000;
        }
        return samples;
      },
    },
    options,
  );
}
