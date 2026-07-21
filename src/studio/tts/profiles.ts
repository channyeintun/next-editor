import { sha256HexOfJson } from "../hash";

/**
 * TTS provider surface (docs/agent-lesson-production.md §6). A voice profile
 * pins provider + voice + settings; the request hash over (profile, speech
 * text, lexicon version, seed) content-addresses each synthesized dialog, so
 * a narration segment is synthesized once and every later build reuses
 * identical bytes from the cache.
 *
 * The one provider is `pocket-tts-web`: Kyutai's pocket-tts exported to ONNX
 * and run in the page over onnxruntime-web (KevinAHM's export, pinned
 * revision). Seeded flow-matching noise makes synthesis reproducible. A
 * future provider (hosted TTS with real word timestamps, another local
 * model) plugs in as a new profile shape in this union plus a branch in the
 * in-page Director's provider dispatch.
 */

export interface PocketVoiceProfile {
  id: string;
  providerId: "pocket-tts-web";
  /** Immutable (revision-pinned) base URL of the exported ONNX bundle. */
  bundleBaseUrl: string;
  bundleName: string;
  /** Built-in voice name from voices.bin, or "custom" for a cloned voice. */
  voice: string;
  /** Cloned voice: the locally stored reference sample this profile uses. */
  customVoiceId?: string;
  /** Cloned voice: sample content hash — keys the synthesis cache. */
  customVoiceSha256?: string;
  sampleRate: 24000;
  mimeType: "audio/wav";
}

export type VoiceProfile = PocketVoiceProfile;

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
};

/**
 * Profile for a locally cloned voice (pocket-tts voice cloning). Not in the
 * static registry — cloned voices live in this browser's IndexedDB and are a
 * render-time choice; scripts keep pinning built-in profiles.
 */
export function customVoiceProfileOf(voice: {
  id: string;
  sampleSha256: string;
}): PocketVoiceProfile {
  return {
    id: `pocket-custom-${voice.id}`,
    providerId: "pocket-tts-web",
    bundleBaseUrl: POCKET_BUNDLE_BASE,
    bundleName: "english_2026-04",
    voice: "custom",
    customVoiceId: voice.id,
    customVoiceSha256: voice.sampleSha256,
    sampleRate: 24000,
    mimeType: "audio/wav",
  };
}

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

/**
 * Post-synthesis processing version, folded into every request hash: bump it
 * whenever the audio pipeline after the model changes (v1 = per-dialog
 * silence trimming) so cached dialogs from the old pipeline are not reused.
 */
export const TTS_POST_PROCESS_VERSION = 1;

/** Content address of one synthesis request; the cache key for its audio. */
export function ttsRequestHash(request: TtsRequest): Promise<string> {
  return sha256HexOfJson({
    profile: request.profile,
    speechText: request.speechText,
    lexiconVersion: request.lexiconVersion,
    seed: request.seed,
    postProcessVersion: TTS_POST_PROCESS_VERSION,
  });
}
