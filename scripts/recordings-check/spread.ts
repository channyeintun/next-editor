/**
 * What a recording holds, in one line: its length, its size and how many events each
 * track has. A person reads these to see whether the sample had a preview lesson, a
 * whiteboard lesson and a human recording in it.
 */

import type { Recording } from "../../src/core/src";
import { RECORDING_TRACK_NAMES } from "../../src/core/src/machine/recordingAssembly";

/** m:ss */
export function formatLength(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function formatSize(bytes: number): string {
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(2)} MB`
    : `${(bytes / 1_000).toFixed(1)} KB`;
}

/** Each track that has events, with its count, in the recording's own track order. */
export function trackCounts(recording: Recording): string {
  const counts = RECORDING_TRACK_NAMES.map((name) => [name, recording[name]?.length ?? 0] as const)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name} ${count}`);
  const captions = (recording.captions ?? []).reduce(
    (total, track) => total + track.cues.length,
    0,
  );
  if (captions > 0) counts.push(`captions ${captions}`);
  return counts.join(", ");
}

export function spreadLine(
  name: string,
  recording: Recording,
  bytes: number,
  human: boolean,
): string {
  const kind = human ? "human" : "studio";
  return `${name}  ${kind}  ${formatLength(recording.duration)}  ${formatSize(bytes)}  ${trackCounts(recording)}`;
}
