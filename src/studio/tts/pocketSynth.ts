import { getCustomVoice } from "./customVoices";
import { PocketTtsEngine } from "./pocket/engine";
import { deriveNoiseSeed } from "./pocket/noise";
import type { PocketVoiceProfile } from "./profiles";
import { encodeWavPcm16, floatTo16BitPcm } from "./wav";

/**
 * pocket-tts synthesis adapter: one engine per (bundle, voice), batch WAV out.
 * The noise seed derives from the build seed and the dialog text, so the same
 * dialog under the same plan seed reproduces byte-identical audio — even
 * across a cleared cache. Cloned voices load their reference sample from
 * IndexedDB and derive the voice state at engine load (pocket/engine.ts).
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
export function preloadPocket(
  profile: PocketVoiceProfile,
  onPhase?: (phase: string) => void,
): Promise<unknown> {
  return loadEngine(profile, onPhase);
}

/** Synthesize one dialog to 16-bit PCM mono WAV bytes at the profile's rate. */
export async function synthesizePocketWav(
  profile: PocketVoiceProfile,
  speechText: string,
  baseSeed: number,
): Promise<Uint8Array> {
  const engine = await loadEngine(profile);
  const result = await engine.synthesize(speechText, deriveNoiseSeed(baseSeed, speechText));
  if (result.sampleRate !== profile.sampleRate) {
    throw new Error(
      `pocket-tts produced ${result.sampleRate}Hz audio but the profile pins ${profile.sampleRate}Hz`,
    );
  }
  return encodeWavPcm16(floatTo16BitPcm(result.samples), result.sampleRate);
}
