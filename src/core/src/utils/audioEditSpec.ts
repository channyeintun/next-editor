import type { MediaSpan } from "./mediaSpans";

// ============================================================================
// What a narration edit asks for.
//
// Apart from audioEdit.ts, which decodes the narration and encodes it again
// (the Ogg/Opus muxer and the WAV encoder): the machine's guard, the recording
// edit and the Recording type only read the edit, so they import this, and the
// encoder is loaded only when a take's narration has an edit to apply.
// ============================================================================

export interface AudioEdit {
  /** Spans removed, in the audio's own time (ms). */
  cuts?: readonly MediaSpan[];
  /** Spans silenced in place, in the same time. */
  mutes?: readonly MediaSpan[];
}

export function hasAudioEdit(edit: AudioEdit | undefined): edit is AudioEdit {
  return Boolean(edit && ((edit.cuts?.length ?? 0) > 0 || (edit.mutes?.length ?? 0) > 0));
}
