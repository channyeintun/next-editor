import type { OwnedLesson } from "@next-editor/infra";
import type { Recording } from "../../core/src";
import { loadRecordingFromUrl } from "../../storage/recordingLoad";
import { loadRecordingNarration } from "../../storage/recordingSiblingMedia";
import {
  clampVoiceSamples,
  decodeVoiceAudio,
  MAX_SAMPLE_SECONDS,
  MIN_VOXCPM2_REFERENCE_SECONDS,
  renderVoiceSamples,
  saveCustomVoice,
  type SavedCustomVoice,
  VOICE_SAMPLE_RATE,
} from "./customVoices";

/**
 * A narrator reference taken from one of the signed-in author's own lessons:
 * which lessons can give one, loading a lesson's narration the way the player
 * does (loadRecordingFromUrl, then its sibling audio), suggesting a window of
 * steady speech, and saving that window to the voice library. The picker
 * (NarratorLessonClipPicker) is only the UI over this.
 */

/** The clip lengths offered, in seconds: all within the VoxCPM2 reference bounds. */
export const CLIP_LENGTH_CHOICES = [10, 15, 20] as const;
export const DEFAULT_CLIP_SECONDS = 15;
/** The clip start moves in steps of this many seconds. */
export const CLIP_STEP_SECONDS = 0.5;

/** One of the author's lessons, as the picker lists it. */
export interface LessonClipSource {
  id: string;
  title: string;
  /** What the lesson select shows: the title, marked when the lesson is a draft. */
  label: string;
  /** The lesson's `.ne`, absolute. */
  neUrl: string;
}

/**
 * The `.ne` URL of a lesson row. Uploaded lessons store a site-relative path
 * ("media/lessons/<id>/<id>.ne") that the player loads as `/${lesson.ne}`; an
 * absolute URL is kept as it is. Null when it is not a URL at all.
 */
export function lessonNeUrl(ne: string, origin: string): string | null {
  if (!ne) return null;
  try {
    return new URL(ne, `${origin}/`).toString();
  } catch {
    return null;
  }
}

/** The lessons a reference can come from, in the order `/api/lessons/mine` lists them. */
export function lessonClipSources(lessons: OwnedLesson[], origin: string): LessonClipSource[] {
  const sources: LessonClipSource[] = [];
  for (const lesson of lessons) {
    const neUrl = lessonNeUrl(lesson.ne, origin);
    if (!neUrl) continue;
    const title = lesson.title.trim() || "Untitled lesson";
    sources.push({
      id: lesson.id,
      title,
      label: lesson.status === "draft" ? `${title} (draft)` : title,
      neUrl,
    });
  }
  return sources;
}

/** Rounds `seconds` down to the clip step. */
function floorToStep(seconds: number): number {
  return Math.floor(seconds / CLIP_STEP_SECONDS + 1e-9) * CLIP_STEP_SECONDS;
}

/**
 * The clip lengths a narration of `durationSeconds` can give: the standard
 * ones that fit, or — for a narration shorter than the shortest of them — the
 * whole of it, as long as it reaches the VoxCPM2 minimum. Empty when the
 * narration is too short for a reference.
 */
export function clipLengthChoices(durationSeconds: number): number[] {
  const fitting = CLIP_LENGTH_CHOICES.filter((length) => length <= durationSeconds);
  if (fitting.length > 0) return fitting;
  const whole = Math.min(floorToStep(durationSeconds), MAX_SAMPLE_SECONDS);
  return whole >= MIN_VOXCPM2_REFERENCE_SECONDS ? [whole] : [];
}

/** The length a picked lesson starts with: 15 s when it fits, else the longest that does. */
export function defaultClipLength(choices: readonly number[]): number | null {
  if (choices.length === 0) return null;
  if (choices.includes(DEFAULT_CLIP_SECONDS)) return DEFAULT_CLIP_SECONDS;
  const shorter = choices.filter((length) => length < DEFAULT_CLIP_SECONDS);
  return shorter.length > 0 ? Math.max(...shorter) : Math.min(...choices);
}

/** The latest a clip of `lengthSeconds` can start without running past the end. */
export function maxClipStart(lengthSeconds: number, durationSeconds: number): number {
  return Math.max(0, floorToStep(durationSeconds - lengthSeconds));
}

/** `startSeconds` on the clip step, within [0, maxClipStart]. */
export function clampClipStart(
  startSeconds: number,
  lengthSeconds: number,
  durationSeconds: number,
): number {
  const max = maxClipStart(lengthSeconds, durationSeconds);
  if (!Number.isFinite(startSeconds)) return 0;
  return Math.min(max, Math.max(0, floorToStep(startSeconds)));
}

/** `seconds` as m:ss (whole seconds, rounded down). */
export function formatClipTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

/** The longest lesson title a voice name keeps before it is shortened. */
export const CLIP_NAME_TITLE_LIMIT = 40;

/** The characters of `text` as a reader sees them, so a cut never splits one. */
function graphemesOf(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)).map(
      (part) => part.segment,
    );
  }
  return Array.from(text);
}

/**
 * The library name of a clip: "<lesson title> · m:ss". A long title is cut at
 * the last word break near the limit (or at the limit, for a title without
 * one) and marked with an ellipsis.
 */
export function clipVoiceName(lessonTitle: string, startSeconds: number): string {
  const title = lessonTitle.trim().replace(/\s+/g, " ") || "Lesson";
  const characters = graphemesOf(title);
  let shown = title;
  if (characters.length > CLIP_NAME_TITLE_LIMIT) {
    const head = characters.slice(0, CLIP_NAME_TITLE_LIMIT - 1).join("");
    const lastSpace = head.lastIndexOf(" ");
    const cut = lastSpace >= head.length * 0.6 ? head.slice(0, lastSpace) : head;
    shown = `${cut.trimEnd()}…`;
  }
  return `${shown} · ${formatClipTime(startSeconds)}`;
}

// Speech detection for the suggested clip: frame loudness (RMS) against a
// threshold set from the narration's own level, so a quiet take and a loud one
// are judged alike.
const FRAME_SECONDS = 0.05;
/** A frame this far below the loud end of the narration (−20 dB) is silence. */
const SILENCE_RATIO = 0.1;
/** The loud end of the narration: this fraction of frames is quieter. */
const LOUD_PERCENTILE = 0.95;
/** Below this (about −50 dBFS) a frame is silence however quiet the take is. */
const SILENCE_FLOOR_RMS = 0.003;
/** A pause longer than this breaks "steady speech". */
const MAX_PAUSE_SECONDS = 0.8;
/** A steady window is speech at least this much of the time. */
const MIN_SPEECH_FRACTION = 0.6;

/** Whether each FRAME_SECONDS frame of `samples` holds speech. */
function speechFrames(samples: Float32Array, frameLength: number): Uint8Array {
  const frameCount = Math.floor(samples.length / frameLength);
  const rms = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    let sum = 0;
    const offset = frame * frameLength;
    for (let i = 0; i < frameLength; i++) {
      const value = samples[offset + i];
      sum += value * value;
    }
    rms[frame] = Math.sqrt(sum / frameLength);
  }
  const sorted = rms.slice().sort();
  const loud = sorted.length > 0 ? sorted[Math.floor((sorted.length - 1) * LOUD_PERCENTILE)] : 0;
  const threshold = Math.max(SILENCE_FLOOR_RMS, loud * SILENCE_RATIO);
  const voiced = new Uint8Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) voiced[frame] = rms[frame] >= threshold ? 1 : 0;
  return voiced;
}

/**
 * Where a clip of `clipSeconds` should start, on the clip step: the first
 * window of steady speech — one that opens with speech, is speech most of the
 * time, and has no pause longer than MAX_PAUSE_SECONDS. That skips leading
 * silence (a Studio render opens with a quiet handle) and stretches broken by
 * long pauses. With no such window, the window with the most speech, one that
 * opens with speech ahead of one that does not (the earliest of equals). 0
 * when the narration is no longer than the clip.
 */
export function suggestClipStart(
  samples: Float32Array,
  sampleRate: number,
  clipSeconds: number,
): number {
  const durationSeconds = samples.length / sampleRate;
  const lastStart = maxClipStart(clipSeconds, durationSeconds);
  if (lastStart <= 0) return 0;

  const frameLength = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  const framesPerSecond = sampleRate / frameLength;
  const voiced = speechFrames(samples, frameLength);
  const windowFrames = Math.max(1, Math.round(clipSeconds * framesPerSecond));
  const stepFrames = Math.max(1, Math.round(CLIP_STEP_SECONDS * framesPerSecond));
  const maxPauseFrames = Math.round(MAX_PAUSE_SECONDS * framesPerSecond);

  let bestStart = 0;
  let bestScore = -1;
  for (let step = 0; step * CLIP_STEP_SECONDS <= lastStart + 1e-9; step++) {
    const first = Math.round((step * CLIP_STEP_SECONDS * sampleRate) / frameLength);
    const end = Math.min(voiced.length, first + windowFrames);
    let speech = 0;
    let pause = 0;
    let longestPause = 0;
    let opensWithSpeech = false;
    for (let frame = first; frame < end; frame++) {
      if (voiced[frame]) {
        speech++;
        pause = 0;
        if (frame < first + stepFrames) opensWithSpeech = true;
      } else {
        pause++;
        if (pause > longestPause) longestPause = pause;
      }
    }
    const startSeconds = step * CLIP_STEP_SECONDS;
    if (
      opensWithSpeech &&
      longestPause <= maxPauseFrames &&
      speech >= windowFrames * MIN_SPEECH_FRACTION
    ) {
      return startSeconds;
    }
    // Opening with speech outranks any amount of it: a clip should not start in a pause.
    const score = (opensWithSpeech ? windowFrames + 1 : 0) + speech;
    if (score > bestScore) {
      bestScore = score;
      bestStart = startSeconds;
    }
  }
  return bestStart;
}

function abortError(): DOMException {
  return new DOMException("The lesson load was cancelled", "AbortError");
}

/**
 * Loads the lesson at `neUrl` the way the player does and waits for its
 * narration: inline in the `.ne`, or the sibling audio file beside it. Null
 * when the lesson has no narration. Rejects with an AbortError once `signal`
 * aborts.
 */
async function loadLessonNarrationBlob(neUrl: string, signal: AbortSignal): Promise<Blob | null> {
  const recording = await new Promise<Recording>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    const settle = (finish: () => void) => {
      signal.removeEventListener("abort", onAbort);
      finish();
    };
    loadRecordingFromUrl(neUrl, signal, {
      isStale: () => signal.aborted,
      // Only the narration is wanted: the decoded records themselves are dropped.
      load: () => {},
      appendDelta: () => {},
      extend: () => {},
      addCaptionTrack: () => {},
      mediaSettled: (outcome) =>
        settle(() => ("recording" in outcome ? resolve(outcome.recording) : reject(outcome.error))),
    }).catch((error: unknown) => settle(() => reject(error)));
  });
  signal.throwIfAborted();
  return loadRecordingNarration(recording);
}

/**
 * The narration of the lesson at `neUrl`, decoded at the reference rate
 * (which keeps a long lesson's audio small), or null when it has none.
 */
export async function loadLessonNarration(
  neUrl: string,
  signal: AbortSignal,
): Promise<AudioBuffer | null> {
  const blob = await loadLessonNarrationBlob(neUrl, signal);
  signal.throwIfAborted();
  if (!blob || blob.size === 0) return null;
  const bytes = await blob.arrayBuffer();
  signal.throwIfAborted();
  const decoded = await decodeVoiceAudio(bytes, VOICE_SAMPLE_RATE);
  signal.throwIfAborted();
  return decoded.length > 0 ? decoded : null;
}

/** A window of a lesson's decoded narration, chosen in the picker. */
export interface LessonClip {
  narration: AudioBuffer;
  startSeconds: number;
  lengthSeconds: number;
  lessonTitle: string;
}

/**
 * Renders the clip to the reference format (24 kHz mono) and stores it in the
 * voice library as "<lesson title> · m:ss".
 */
export async function saveLessonClipVoice(clip: LessonClip): Promise<SavedCustomVoice> {
  const length = Math.min(clip.lengthSeconds, clip.narration.duration - clip.startSeconds);
  const samples = await renderVoiceSamples(clip.narration, clip.startSeconds, length);
  return saveCustomVoice(
    clipVoiceName(clip.lessonTitle, clip.startSeconds),
    clampVoiceSamples(samples, VOICE_SAMPLE_RATE),
  );
}
