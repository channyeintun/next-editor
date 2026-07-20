import { createSeededRandom } from "../../cadence";

/**
 * Seeded gaussian noise for the flow-matching sampler. The upstream demo draws
 * from Math.random(), which makes every synthesis unique; the studio needs a
 * dialog's audio to be reproducible from (text, profile, seed), so noise comes
 * from a mulberry32 stream via Box–Muller instead.
 */
export interface GaussianSource {
  next(): number;
}

export function createSeededGaussian(seed: number): GaussianSource {
  const uniform = createSeededRandom(seed);
  return {
    next() {
      let u = 0;
      let v = 0;
      while (u === 0) u = uniform();
      while (v === 0) v = uniform();
      return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    },
  };
}

/** Stable 32-bit seed derived from a base seed and a text (FNV-1a mix). */
export function deriveNoiseSeed(baseSeed: number, text: string): number {
  let hash = 2166136261 ^ baseSeed;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
