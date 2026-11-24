/** The times a check compares a recording at. */

import type { Recording } from "../../src/core/src";

/**
 * Every stamp of a track the page replays (the pointer is replayed outside the
 * machine and has its own samples), sorted. These are where tracks change, so a
 * check looks at and around them.
 */
export function replayedStamps(recording: Recording): number[] {
  return [
    ...recording.frames,
    ...(recording.workspaceEvents ?? []),
    ...(recording.runtimeEvents ?? []),
    ...(recording.chatEvents ?? []),
    ...(recording.whiteboardEvents ?? []),
    ...(recording.slideEvents ?? []),
    ...(recording.previewEvents ?? []),
  ]
    .map((event) => event.timestamp)
    .sort((left, right) => left - right);
}

/**
 * A grid every `everyMs` from 0 to the end, plus each replayed stamp and a
 * millisecond either side of it, sorted, each once.
 */
export function checkTimes(recording: Recording, everyMs: number): number[] {
  const times = new Set<number>();
  for (let time = 0; time <= recording.duration; time += everyMs) times.add(time);
  for (const stamp of replayedStamps(recording)) {
    for (const time of [stamp - 1, stamp, stamp + 1]) {
      if (time >= 0 && time <= recording.duration) times.add(time);
    }
  }
  times.add(recording.duration);
  return [...times].sort((left, right) => left - right);
}
