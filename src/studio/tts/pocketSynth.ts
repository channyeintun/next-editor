import { getCustomVoice } from "./customVoices";
import { PocketTtsEngine } from "./pocket/engine";
import { narrationNoiseSeed } from "./pocket/noise";
import type { PocketVoiceProfile } from "./profiles";
import type { DialogSynthProvider } from "./synthProvider";
import { encodeWavPcm16, floatTo16BitPcm, trimSilence } from "./wav";

/**
 * pocket-tts synthesis adapter: one engine per (bundle, voice), batch WAV out.
 * Every dialog in a render receives the same noise seed. PocketTTS noise also
 * affects voice characteristics, so changing it per dialog can create audible
 * pitch/timbre drift. Cloned voices load their reference sample from IndexedDB
 * and derive the voice state at engine load (pocket/engine.ts).
 */

const engines = new Map<string, Promise<PocketTtsEngine>>();

async function createEngine(
  profile: PocketVoiceProfile,
  onPhase?: (phase: string) => void,
): Promise<PocketTtsEngine> {
  let customVoiceSamples: Float32Array | undefined;
  if (profile.customVoiceId) {
    const voice = await getCustomVoice(profile.customVoiceId);
    if (!voice) {
      throw new Error(
        `Cloned voice "${profile.customVoiceId}" is not in this browser — re-clone it in the studio`,
      );
    }
    customVoiceSamples = voice.samples;
  }
  return PocketTtsEngine.load(
    { bundleBaseUrl: profile.bundleBaseUrl, voice: profile.voice, customVoiceSamples },
    onPhase,
  );
}

function loadEngine(
  profile: PocketVoiceProfile,
  onPhase?: (phase: string) => void,
): Promise<PocketTtsEngine> {
  const key = `${profile.bundleBaseUrl}|${profile.voice}|${profile.customVoiceId ?? ""}|${profile.customVoiceSha256 ?? ""}`;
  let promise = engines.get(key);
  if (!promise) {
    promise = createEngine(profile, onPhase);
    promise.catch(() => engines.delete(key));
    engines.set(key, promise);
  }
  return promise;
}

/** Warm the bundle download/session build before the first dialog needs it. */
function preloadPocket(
  profile: PocketVoiceProfile,
  onPhase?: (phase: string) => void,
): Promise<unknown> {
  return loadEngine(profile, onPhase);
}

export interface PocketDialogSynthesis {
  wav: Uint8Array;
  /** Text chunks that hit the engine's frame cap (see PocketSynthesisResult). */
  cappedChunkCount: number;
}

/** Synthesize one dialog to 16-bit PCM mono WAV bytes at the profile's rate. */
export async function synthesizePocketDialog(
  profile: PocketVoiceProfile,
  speechText: string,
  noiseSeed: number,
): Promise<PocketDialogSynthesis> {
  const engine = await loadEngine(profile);
  const result = await engine.synthesize(speechText, noiseSeed);
  if (result.sampleRate !== profile.sampleRate) {
    throw new Error(
      `pocket-tts produced ${result.sampleRate}Hz audio but the profile pins ${profile.sampleRate}Hz`,
    );
  }
  // Trim the model's leading/trailing silence so speech starts where the
  // schedule (captions, mark anchors) says the dialog starts.
  const trimmed = trimSilence(result.samples, result.sampleRate);
  return {
    wav: encodeWavPcm16(floatTo16BitPcm(trimmed), result.sampleRate),
    cappedChunkCount: result.cappedChunkCount,
  };
}

/**
 * The Director's Pocket-TTS provider: every dialog of a render shares one
 * noise seed derived from the script's, and preload warms the engine before
 * the first uncached dialog needs it. A take that hit the engine's frame cap
 * is flagged so the Director can warn about it.
 */
export function pocketSynthProvider(
  profile: PocketVoiceProfile,
  buildSeed: number,
  onPhase?: (phase: string) => void,
): DialogSynthProvider {
  const noiseSeed = narrationNoiseSeed(buildSeed);
  return {
    sampleRate: profile.sampleRate,
    mimeType: profile.mimeType,
    seed: noiseSeed,
    preload: () => preloadPocket(profile, onPhase),
    synthesize: async (speechText) => {
      const { wav, cappedChunkCount } = await synthesizePocketDialog(
        profile,
        speechText,
        noiseSeed,
      );
      return { wav, hitFrameCap: cappedChunkCount > 0 };
    },
  };
}

/** synthesizePocketDialog's WAV alone, for one-off previews. */
export async function synthesizePocketWav(
  profile: PocketVoiceProfile,
  speechText: string,
  noiseSeed: number,
): Promise<Uint8Array> {
  return (await synthesizePocketDialog(profile, speechText, noiseSeed)).wav;
}
