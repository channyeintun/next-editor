import { sha256HexOfJson } from "../hash";

/**
 * TTS provider surface (docs/agent-lesson-production.md §6). A voice profile
 * pins provider + voice + settings; the request hash over (profile, speech
 * text, lexicon version) content-addresses the synthesized media in the cache,
 * so narration is synthesized once and every later build reuses identical
 * bytes. The only implemented provider is the local macOS `say` synthesizer
 * (driven by scripts/studio-director.ts); a hosted provider with real word
 * timestamps plugs in as a new profile + synthesis backend without touching
 * the cache or alignment contracts.
 */

export interface VoiceProfile {
  id: string;
  providerId: "macos-say";
  voice: string;
  /** Provider-native rate setting (words per minute for `say`). */
  rateWpm: number;
  outputFormat: "m4a";
  mimeType: "audio/mp4";
}

export const VOICE_PROFILES: Record<string, VoiceProfile> = {
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

/** Content address of a synthesis request; the cache key for audio + metadata. */
export function ttsRequestHash(request: TtsRequest): Promise<string> {
  return sha256HexOfJson({
    providerId: request.profile.providerId,
    voice: request.profile.voice,
    rateWpm: request.profile.rateWpm,
    outputFormat: request.profile.outputFormat,
    speechText: request.speechText,
    lexiconVersion: request.lexiconVersion,
  });
}

/** Sidecar metadata stored next to the cached audio. */
export interface TtsCacheMeta {
  requestHash: string;
  profileId: string;
  providerId: string;
  voice: string;
  rateWpm: number;
  mimeType: string;
  durationMs: number;
  audioSha256: string;
  speechText: string;
  lexiconVersion: number;
  createdAtIso: string;
}
