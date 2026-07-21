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

/**
 * Normalize one plan seed for every independently synthesized dialog.
 * PocketTTS noise affects voice characteristics, so deriving a new seed from
 * each dialog's text can sound like the speaker changes between segments.
 */
export function narrationNoiseSeed(baseSeed: number): number {
  return baseSeed >>> 0;
}
