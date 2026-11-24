/** The times a check compares a recording at. */

import type { Recording } from "../../src/core/src";
import { PAGE_TRACKS, type PageTrack } from "./page.ts";

/** The recorded events that drive each panel of the page. */
const PANEL_EVENTS: Record<
  PageTrack,
  (recording: Recording) => ReadonlyArray<{ timestamp: number }>
> = {
  editor: (recording) => recording.frames,
  workspace: (recording) => recording.workspaceEvents ?? [],
  runtime: (recording) => recording.runtimeEvents ?? [],
  chat: (recording) => recording.chatEvents ?? [],
  whiteboard: (recording) => recording.whiteboardEvents ?? [],
  slides: (recording) => recording.slideEvents ?? [],
  preview: (recording) => recording.previewEvents ?? [],
};

/**
 * Whether anything in the recording drives `track`'s panel. The editor with no
 * frames still shows the open file's text, which the workspace's events set.
 */
export function panelHasEvents(recording: Recording, track: PageTrack): boolean {
  if (PANEL_EVENTS[track](recording).length > 0) return true;
  return track === "editor" && PANEL_EVENTS.workspace(recording).length > 0;
}

/**
 * Every stamp of a track the page replays (the pointer is replayed outside the
 * machine and has its own samples), sorted. These are where tracks change, so a
 * check looks at and around them.
 */
export function replayedStamps(recording: Recording): number[] {
  return PAGE_TRACKS.flatMap((track) => PANEL_EVENTS[track](recording))
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
