import { sha256HexOfJson } from "../hash";

/**
 * TTS provider surface (docs/agent-lesson-production.md §6). A voice profile
 * pins provider + voice + settings; the request hash over (profile, speech
 * text, lexicon version) content-addresses each synthesized dialog, so a
 * narration segment is synthesized once and every later build reuses identical
 * bytes from the cache.
 *
 * Providers:
 * - `kokoro-js` (default): Kokoro-82M over onnxruntime — WASM/WebGPU in the
 *   browser (the /studio page synthesizes at render time), native CPU under
 *   bun/node. Apache-2.0 weights, fully local.
 * - `macos-say`: the legacy M0/M1 whole-narration path; kept for the archived
 *   fixtures, not used by current scripts.
 */

export interface SayVoiceProfile {
  id: string;
  providerId: "macos-say";
  voice: string;
  /** Provider-native rate setting (words per minute for `say`). */
  rateWpm: number;
  outputFormat: "m4a";
  mimeType: "audio/mp4";
}

export interface KokoroVoiceProfile {
  id: string;
  providerId: "kokoro-js";
  /** Hugging Face model id the weights load from. */
  modelId: string;
  /** Quantization — q8 keeps the download ~90MB with near-fp32 quality. */
  dtype: "q8" | "fp32";
  voice: string;
  speed: number;
  sampleRate: 24000;
  mimeType: "audio/wav";
}

export type VoiceProfile = SayVoiceProfile | KokoroVoiceProfile;

export const VOICE_PROFILES: Record<string, VoiceProfile> = {
  "kokoro-af-heart-v1": {
    id: "kokoro-af-heart-v1",
    providerId: "kokoro-js",
    modelId: "onnx-community/Kokoro-82M-v1.0-ONNX",
    dtype: "q8",
    voice: "af_heart",
    speed: 1,
    sampleRate: 24000,
    mimeType: "audio/wav",
  },
  "say-samantha-v1": {
    id: "say-samantha-v1",
    providerId: "macos-say",
    voice: "Samantha",
    rateWpm: 130,
    outputFormat: "m4a",
    mimeType: "audio/mp4",
  },
};

export function requireVoiceProfile(id: string): VoiceProfile {
  const profile = VOICE_PROFILES[id];
  if (!profile) {
    throw new Error(
      `Unknown voice profile "${id}" — known: ${Object.keys(VOICE_PROFILES).join(", ")}`,
    );
  }
  return profile;
}

export interface TtsRequest {
  profile: VoiceProfile;
  speechText: string;
  lexiconVersion: number;
}

/** Content address of one synthesis request; the cache key for its audio. */
export function ttsRequestHash(request: TtsRequest): Promise<string> {
  return sha256HexOfJson({
    profile: request.profile,
    speechText: request.speechText,
    lexiconVersion: request.lexiconVersion,
  });
}
