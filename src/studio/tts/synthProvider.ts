import type { CachedDialogWav } from "./dialogCache";

/**
 * One narration provider as the in-page Director drives it: synthesize a
 * dialog's speech text into a take, with the seed folded into each dialog's
 * request hash. Each TTS adapter builds its own — `pocketSynthProvider`,
 * `voxCpm2SynthProvider`, `athanLabSynthProvider` — so a provider's seed and
 * warm-up policy live beside the code they describe, not in the Director.
 */
export interface DialogSynthProvider {
  sampleRate: number;
  mimeType: string;
  /** Shared narration seed folded into each dialog's request hash. */
  seed: number;
  /** Called once, at the first dialog that misses the cache. */
  preload(): Promise<unknown>;
  synthesize(speechText: string): Promise<CachedDialogWav>;
  /**
   * Turn a take as synthesized — and as the dialog cache keeps it — into the
   * take the Director validates and schedules, e.g. by trimming the model's
   * lead-in silence. It runs on every build, over cache hits too, so it must
   * be deterministic and idempotent; changing it never invalidates a cached
   * (possibly paid) take. Adapters that already shape the take while
   * synthesizing return the bytes unchanged.
   */
  prepareTake(wav: Uint8Array): Uint8Array;
}
