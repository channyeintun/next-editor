import { sha256HexOfJson } from "../hash";

/**
 * TTS provider surface (docs/agent-lesson-production.md §6). A voice profile
 * pins provider + voice + settings; the request hash over (profile, speech
 * text, lexicon version, seed) content-addresses each synthesized dialog, so
 * a narration segment is synthesized once and every later build reuses
 * identical bytes from the cache.
 *
 * Providers:
 * - `pocket-tts-web` (default): Kyutai's pocket-tts exported to ONNX and run
 *   in the page over onnxruntime-web (KevinAHM's export, pinned revision).
 *   Seeded flow-matching noise makes synthesis reproducible.
 * - `kokoro-js`: Kokoro-82M via kokoro-js — kept as a fallback profile.
 * - `macos-say`: the legacy M0/M1 whole-narration path; archived fixture only.
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

export interface PocketVoiceProfile {
  id: string;
  providerId: "pocket-tts-web";
  /** Immutable (revision-pinned) base URL of the exported ONNX bundle. */
  bundleBaseUrl: string;
  bundleName: string;
  voice: string;
  sampleRate: 24000;
  mimeType: "audio/wav";
}

export type VoiceProfile = SayVoiceProfile | KokoroVoiceProfile | PocketVoiceProfile;

const POCKET_BUNDLE_BASE =
  "https://huggingface.co/spaces/KevinAHM/pocket-tts-web/resolve/d0c0c79b7712256a32d691c67f20b8ae2e020d00/onnx/english_2026-04";

export const VOICE_PROFILES: Record<string, VoiceProfile> = {
  "pocket-alba-v1": {
    id: "pocket-alba-v1",
    providerId: "pocket-tts-web",
    bundleBaseUrl: POCKET_BUNDLE_BASE,
    bundleName: "english_2026-04",
    voice: "alba",
    sampleRate: 24000,
    mimeType: "audio/wav",
  },
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
  /** Noise seed for seeded providers (pocket-tts flow matching). */
  seed?: number;
}

/** Content address of one synthesis request; the cache key for its audio. */
export function ttsRequestHash(request: TtsRequest): Promise<string> {
  return sha256HexOfJson({
    profile: request.profile,
    speechText: request.speechText,
    lexiconVersion: request.lexiconVersion,
    seed: request.seed,
  });
}
