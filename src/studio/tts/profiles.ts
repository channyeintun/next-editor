import { sha256HexOfJson } from "../hash";

/**
 * TTS provider surface (docs/agent-lesson-production.md §6). A voice profile
 * pins provider + voice + settings; the request hash over (profile, speech
 * text, lexicon version, seed) content-addresses each synthesized dialog, so
 * a narration segment is synthesized once and every later build reuses
 * identical bytes from the cache.
 *
 * `pocket-tts-web` runs Kyutai's English model in the page over
 * onnxruntime-web. `voxcpm2-modal` calls the authenticated first-party Worker
 * proxy, which is separately authorized by a per-user D1 flag. Provider
 * credentials are deliberately absent from profiles and request hashes.
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

export interface ModalVoxCpm2VoiceProfile {
  id: string;
  providerId: "voxcpm2-modal";
  model: "openbmb/VoxCPM2";
  /** Immutable Hugging Face model revision baked into the Modal image. */
  modelRevision: string;
  /** Pinned inference package baked into the Modal image. */
  packageVersion: string;
  /**
   * Server-pinned prompt version controlling the narrator's delivery. The
   * prompt text itself lives in integrations/modal/voxcpm2_tts.py and never
   * crosses the wire; this id exists so the prompt version reaches
   * `ttsRequestHash`. Bump it in lockstep with that text, or cached dialogs
   * keep replaying the old delivery.
   *
   * v2 (2026-07-28): conversational — v1's "educator"/"steady pace" phrasing
   * made the model read the script aloud rather than talk through it.
   * v3 (2026-07-28): defers rate, energy, and pitch to the reference
   * recording — v2's mood words made the delivery soft, slow, and sleepy.
   */
  voiceDesignId: "burmese-educator-v3";
  /** Browser-local reference sample used to keep one speaker across dialogs. */
  referenceVoiceId?: string;
  /** Reference sample hash — keys the synthesis cache without embedding audio. */
  referenceVoiceSha256?: string;
  referenceSampleRate: 24000;
  cfgValue: 2;
  inferenceTimesteps: 10;
  sampleRate: 48000;
  mimeType: "audio/wav";
}

export type VoiceProfile = PocketVoiceProfile | ModalVoxCpm2VoiceProfile;

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
  "modal-voxcpm2-burmese-v1": {
    id: "modal-voxcpm2-burmese-v1",
    providerId: "voxcpm2-modal",
    model: "openbmb/VoxCPM2",
    modelRevision: "bffb3df5a29440629464e5e839f4d214c8714c3d",
    packageVersion: "2.0.3",
    voiceDesignId: "burmese-educator-v3",
    referenceSampleRate: 24000,
    cfgValue: 2,
    inferenceTimesteps: 10,
    sampleRate: 48000,
    mimeType: "audio/wav",
  },
};

export const MODAL_VOXCPM2_BURMESE_PROFILE = VOICE_PROFILES[
  "modal-voxcpm2-burmese-v1"
] as ModalVoxCpm2VoiceProfile;

/** Bind the server-pinned Burmese narrator style to one browser-local speaker. */
export function modalVoxCpm2BurmeseProfileOf(voice: {
  id: string;
  sampleSha256: string;
}): ModalVoxCpm2VoiceProfile {
  return {
    ...MODAL_VOXCPM2_BURMESE_PROFILE,
    id: `${MODAL_VOXCPM2_BURMESE_PROFILE.id}-reference-${voice.sampleSha256}`,
    referenceVoiceId: voice.id,
    referenceVoiceSha256: voice.sampleSha256,
  };
}

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
  // Object.hasOwn so an id like "constructor" misses rather than resolving to
  // an inherited member and slipping past the falsy guard below.
  const profile = Object.hasOwn(VOICE_PROFILES, id) ? VOICE_PROFILES[id] : undefined;
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
  /** Shared narration seed for deterministic providers. */
  seed?: number;
}

/**
 * Synthesis pipeline version, folded into every request hash so cached dialogs
 * are regenerated when an audio-affecting contract changes.
 *
 * v1: per-dialog silence trimming
 * v2: one deterministic noise seed shared by every dialog in a render
 * v3: mandatory reference-voice identity for Modal VoxCPM2 narration
 */
export const TTS_PIPELINE_VERSION = 3;

/** Content address of one synthesis request; the cache key for its audio. */
export function ttsRequestHash(request: TtsRequest): Promise<string> {
  return sha256HexOfJson({
    profile: request.profile,
    speechText: request.speechText,
    lexiconVersion: request.lexiconVersion,
    seed: request.seed,
    pipelineVersion: TTS_PIPELINE_VERSION,
  });
}
