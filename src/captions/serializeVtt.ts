import type { CaptionCue } from "../core/src/types";

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function formatTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
}

/**
 * Serializes cues into a minimal WebVTT document — the canonical sibling-caption
 * format, since `fetchVttFile` (src/hooks/useUrlLoader.ts) only accepts documents
 * that start with "WEBVTT". Uploads canonicalize .srt input through this so every
 * hosted caption file is loadable. Invalid cues are dropped and blank lines inside
 * cue text are flattened — a blank line would otherwise terminate the cue early.
 */
export function serializeCuesToVtt(cues: CaptionCue[]): string {
  const body = cues
    .filter((cue) => cue.start >= 0 && cue.end > cue.start && cue.text.trim().length > 0)
    .sort((a, b) => a.start - b.start)
    .map((cue) => {
      const text = cue.text.replace(/\n\s*\n/g, "\n").trim();
      return `${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n${text}`;
    })
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}
