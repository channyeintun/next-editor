// @ts-expect-error — the package ships no type declarations; typed via StretchFactory below.
import createStretchNode from "signalsmith-stretch";

/**
 * Signalsmith Stretch — a WASM/AudioWorklet time-stretch used to change playback speed
 * without shifting pitch. Unlike a resample-plus-pitch-correct chain (the previous
 * SoundTouch wiring: `AudioBufferSourceNode.playbackRate` resamples, coupling tempo and
 * pitch, then a second node cancels the induced octave shift), Stretch is a *single-stage*
 * phase-vocoder-style time-stretch driven from a loaded sample buffer — the same class of
 * algorithm behind high-quality speed controls. This removes the double-processing
 * artifacts that made the WSOLA path sound unnatural at 2x.
 *
 * The node is a self-contained player: you `addBuffers()` the decoded channels, then
 * `schedule({ input, output, rate, semitones })` / `start()` to drive playback position and
 * speed. `semitones` is always left at 0 so pitch is preserved exactly.
 *
 * Loading and per-`AudioContext` node creation are cached so repeated playback actors share
 * the (async, non-trivial) worklet registration.
 */

/** A scheduled change to playback (see the signalsmith-stretch README). */
export interface StretchSchedule {
  /** AudioContext time (seconds) this change takes effect. */
  output?: number;
  /** Whether the node is processing audio. */
  active?: boolean;
  /** Position in the input buffer (seconds). */
  input?: number;
  /** Playback rate, e.g. 0.5 = half speed. */
  rate?: number;
  /** Pitch shift in semitones — always 0 here (pitch preserved). */
  semitones?: number;
  loopStart?: number;
  loopEnd?: number;
}

export interface StretchNode extends AudioNode {
  /** Current playback position within the loaded input buffer (seconds). */
  inputTime: number;
  addBuffers(channels: Float32Array[]): Promise<number>;
  dropBuffers(toSeconds?: number): Promise<unknown>;
  start(
    when?: number | StretchSchedule,
    offset?: number,
    duration?: number,
    rate?: number,
    semitones?: number,
  ): Promise<unknown>;
  stop(when?: number): Promise<unknown>;
  schedule(change: StretchSchedule, adjustPrevious?: boolean): Promise<unknown>;
  setUpdateInterval(seconds: number, callback?: (inputTime: number) => void): Promise<unknown>;
  latency(): Promise<number>;
}

type StretchFactory = (
  audioContext: BaseAudioContext,
  options?: AudioWorkletNodeOptions,
) => Promise<StretchNode>;

const factory = createStretchNode as StretchFactory;

const stretchNodeByContext = new WeakMap<BaseAudioContext, Promise<StretchNode>>();

/**
 * Returns true when the current environment can host the Stretch worklet. Mirrors the guard
 * used for the previous pitch worklet so off-speed playback degrades gracefully (native
 * resample) rather than throwing where AudioWorklet is unavailable.
 */
export const canUseStretch = (): boolean =>
  typeof AudioWorkletNode !== "undefined" && typeof globalThis.AudioContext !== "undefined";

/**
 * Lazily creates (and caches) a Stretch node for the given context. The node registers its
 * worklet module on first use; subsequent callers on the same context reuse the same node.
 */
export const getStretchNode = (
  audioContext: AudioContext,
  options?: AudioWorkletNodeOptions,
): Promise<StretchNode> => {
  let node = stretchNodeByContext.get(audioContext);
  if (!node) {
    node = factory(audioContext, options);
    stretchNodeByContext.set(audioContext, node);
  }
  return node;
};
