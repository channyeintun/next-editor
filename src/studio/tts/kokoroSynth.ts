import { KokoroTTS } from "kokoro-js";
import type { KokoroVoiceProfile } from "./profiles";
import { encodeWavPcm16, floatTo16BitPcm } from "./wav";

/**
 * Kokoro-82M synthesis over onnxruntime. In the browser this runs on
 * onnxruntime-web — "wasm" by default because its output is reproducible
 * across runs (the repeatability comparison hashes audio bytes); "webgpu" is
 * an opt-in speedup whose floats can differ per GPU. Under bun/node the
 * native CPU backend loads instead. The model weights (~90MB for q8) download
 * once from the Hugging Face hub and land in the environment's cache
 * (browser Cache storage / ~/.cache/huggingface).
 */

export type KokoroDevice = "wasm" | "webgpu" | "cpu";

export function defaultKokoroDevice(): KokoroDevice {
  return typeof window === "undefined" ? "cpu" : "wasm";
}

const loadedModels = new Map<string, Promise<KokoroTTS>>();

function loadModel(profile: KokoroVoiceProfile, device: KokoroDevice): Promise<KokoroTTS> {
  const key = `${profile.modelId}|${profile.dtype}|${device}`;
  let promise = loadedModels.get(key);
  if (!promise) {
    promise = KokoroTTS.from_pretrained(profile.modelId, {
      dtype: profile.dtype,
      device,
    });
    // A failed load (offline, unsupported backend) must not poison the cache.
    promise.catch(() => loadedModels.delete(key));
    loadedModels.set(key, promise);
  }
  return promise;
}

/** Warm the model download/compile before the first dialog needs it. */
export function preloadKokoro(profile: KokoroVoiceProfile, device: KokoroDevice): Promise<unknown> {
  return loadModel(profile, device);
}

/** Synthesize one dialog to 16-bit PCM mono WAV bytes at the profile's rate. */
export async function synthesizeKokoroWav(
  profile: KokoroVoiceProfile,
  speechText: string,
  device: KokoroDevice = defaultKokoroDevice(),
): Promise<Uint8Array> {
  const tts = await loadModel(profile, device);
  const audio = await tts.generate(speechText, {
    voice: profile.voice,
    speed: profile.speed,
  } as NonNullable<Parameters<KokoroTTS["generate"]>[1]>);
  if (audio.sampling_rate !== profile.sampleRate) {
    throw new Error(
      `Kokoro produced ${audio.sampling_rate}Hz audio but the profile pins ${profile.sampleRate}Hz`,
    );
  }
  return encodeWavPcm16(floatTo16BitPcm(audio.audio), audio.sampling_rate);
}
