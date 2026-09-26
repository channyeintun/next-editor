import { normalizeMediaSpans, type MediaSpan } from "./mediaSpans";
import { encodeMonoPcmToOggOpus, OGG_OPUS_MIME } from "./oggOpus";
import { encodeWavPcm16, floatTo16BitPcm } from "./wavPcm16";

// ============================================================================
// Cutting and silencing a take's narration.
//
// A retake discards what the microphone kept recording past its safe point,
// and an edit cuts or mutes spans of a finished take. MediaRecorder's WebM
// cannot be cut in place, so the narration is decoded, edited as samples, and
// encoded again: Ogg/Opus through WebCodecs, 16-bit WAV where that is missing.
// ============================================================================

/**
 * Speech needs no more. Opus codes it super-wideband at this rate, and decoding a
 * take costs half the memory it would at 48 kHz (20 minutes is ~115 MB).
 */
export const AUDIO_EDIT_SAMPLE_RATE = 24_000;

/** Fades either side of a cut, so a splice mid-waveform does not click. */
const SPLICE_FADE_MS = 8;

export interface AudioEdit {
  /** Spans removed, in the audio's own time (ms). */
  cuts?: readonly MediaSpan[];
  /** Spans silenced in place, in the same time. */
  mutes?: readonly MediaSpan[];
}

export function hasAudioEdit(edit: AudioEdit | undefined): edit is AudioEdit {
  return Boolean(edit && ((edit.cuts?.length ?? 0) > 0 || (edit.mutes?.length ?? 0) > 0));
}

function fadeOut(samples: Float32Array, end: number, length: number): void {
  const start = Math.max(0, end - length);
  const span = end - start;
  for (let index = start; index < end; index++) {
    samples[index] *= (end - index) / (span + 1);
  }
}

function fadeIn(samples: Float32Array, start: number, length: number): void {
  const end = Math.min(samples.length, start + length);
  const span = end - start;
  for (let index = start; index < end; index++) {
    samples[index] *= (index - start + 1) / (span + 1);
  }
}

/** Silences `mutes` and removes `cuts` from mono samples. Pure: `samples` is not changed. */
export function applyAudioEditToSamples(
  samples: Float32Array<ArrayBuffer>,
  sampleRate: number,
  edit: AudioEdit,
): Float32Array<ArrayBuffer> {
  const toFrame = (ms: number) =>
    Math.min(samples.length, Math.max(0, Math.round((ms / 1000) * sampleRate)));
  const fadeFrames = Math.max(1, Math.round((SPLICE_FADE_MS / 1000) * sampleRate));
  const mutes = normalizeMediaSpans(edit.mutes ?? []);
  const cuts = normalizeMediaSpans(edit.cuts ?? []);

  const working = samples.slice();
  for (const mute of mutes) {
    const start = toFrame(mute.start);
    const end = toFrame(mute.end);
    fadeOut(working, start, fadeFrames);
    working.fill(0, start, end);
    fadeIn(working, end, fadeFrames);
  }
  if (cuts.length === 0) return working;

  let kept = working.length;
  for (const cut of cuts) kept -= toFrame(cut.end) - toFrame(cut.start);
  const edited = new Float32Array(Math.max(0, kept));
  const splices: number[] = [];

  let read = 0;
  let write = 0;
  for (const cut of cuts) {
    const start = toFrame(cut.start);
    const end = toFrame(cut.end);
    edited.set(working.subarray(read, start), write);
    write += start - read;
    read = end;
    splices.push(write);
  }
  edited.set(working.subarray(read), write);

  for (const splice of splices) {
    fadeOut(edited, splice, fadeFrames);
    fadeIn(edited, splice, fadeFrames);
  }
  return edited;
}

/** The audio as mono samples at `sampleRate`: every channel averaged. */
async function decodeToMono(blob: Blob, sampleRate: number): Promise<Float32Array<ArrayBuffer>> {
  // An OfflineAudioContext opens no audio device and needs no user gesture.
  const context = new OfflineAudioContext(1, 1, sampleRate);
  const buffer = await context.decodeAudioData(await blob.arrayBuffer());
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);

  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < mono.length; index++) {
      mono[index] += data[index] / buffer.numberOfChannels;
    }
  }
  return mono;
}

/** Ogg/Opus, or 16-bit WAV where WebCodecs cannot encode Opus. */
export async function encodeEditedAudio(
  samples: Float32Array<ArrayBuffer>,
  sampleRate: number,
): Promise<Blob> {
  if (samples.length === 0) {
    throw new Error("The edit leaves no narration");
  }
  if (typeof AudioEncoder !== "undefined") {
    try {
      const bytes = await encodeMonoPcmToOggOpus(
        {
          length: samples.length,
          sampleRate,
          read: (offset, frames) => samples.subarray(offset, offset + frames),
        },
        { vendor: "next-editor" },
      );
      return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: OGG_OPUS_MIME });
    } catch (error) {
      console.warn("Could not encode the edited narration as Opus; saving it as WAV:", error);
    }
  }
  const wav = encodeWavPcm16(floatTo16BitPcm(samples), sampleRate);
  return new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" });
}

/** Applies `edit` to a narration file and returns the edited file. */
export async function editRecordedAudio(blob: Blob, edit: AudioEdit): Promise<Blob> {
  const samples = await decodeToMono(blob, AUDIO_EDIT_SAMPLE_RATE);
  return encodeEditedAudio(
    applyAudioEditToSamples(samples, AUDIO_EDIT_SAMPLE_RATE, edit),
    AUDIO_EDIT_SAMPLE_RATE,
  );
}
