import { PocketTtsEngine } from "./pocket/engine";
import { deriveNoiseSeed } from "./pocket/noise";
import type { PocketVoiceProfile } from "./profiles";
import { encodeWavPcm16, floatTo16BitPcm } from "./wav";

/**
 * pocket-tts synthesis adapter: one engine per (bundle, voice), batch WAV out.
 * The noise seed derives from the build seed and the dialog text, so the same
 * dialog under the same plan seed reproduces byte-identical audio — even
 * across a cleared cache.
 */

const engines = new Map<string, Promise<PocketTtsEngine>>();

function loadEngine(
  profile: PocketVoiceProfile,
  onPhase?: (phase: string) => void,
): Promise<PocketTtsEngine> {
  const key = `${profile.bundleBaseUrl}|${profile.voice}`;
  let promise = engines.get(key);
  if (!promise) {
    promise = PocketTtsEngine.load(
      { bundleBaseUrl: profile.bundleBaseUrl, voice: profile.voice },
      onPhase,
    );
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
