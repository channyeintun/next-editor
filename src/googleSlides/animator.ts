// The build-step animation timeline of an imported Google Slides slide, ported
// from the reference implementation (see google-slide-research.md §1.5). The
// math is pure and unit-tested here, and it is also what ships: the sandboxed
// slide frame's animation bridge (utils/sandboxedSlideDocument.ts) inlines these
// functions verbatim via .toString().
//
// Keep every exported function a self-contained `function` declaration: nest
// helpers inside it and reference only globals (Array, Map, Math, Number). No
// runtime imports and no module-scope constants or helpers — they would not
// exist inside the frame. Type-only imports are erased and are fine.

import type { DeckStepEntry, DeckStepTrack } from "./types";

interface TimedEntry {
  entry: DeckStepEntry;
  /** Absolute start time on the deck timeline (ms). */
  start: number;
  /** Absolute end time (start + duration). */
  end: number;
}

export interface DeckTimeline {
  entries: TimedEntry[];
  /** End time of each step; stepEndTimes[i] is the time at which step i is fully shown. */
  stepEndTimes: number[];
  /** Total timeline length (ms) = time at which every step is revealed. */
  total: number;
}

/**
 * Lays steps end-to-end on a single timeline. Each step starts where the
 * previous ended; within a step, an entry starts at its delay and lasts its
 * duration, so the step's length is the max of (delay + duration) over its
 * entries.
 *
 * The steps arrive in the frame by postMessage, so they are validated here
 * rather than trusted: delays and durations are clamped to 0..60 s, at most
 * 1000 steps, 10000 entries and 4 tracks per entry are read, an entry needs a
 * string elementId of at most 1024 characters, only opacity/scale/translate
 * tracks are kept, and non-finite numbers become 0.
 */
export function buildTimeline(steps: unknown): DeckTimeline {
  function finite(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }
  function clampTime(value: unknown): number {
    return Math.min(60000, Math.max(0, finite(value, 0)));
  }

  const entries: TimedEntry[] = [];
  const stepEndTimes: number[] = [];
  let cursor = 0;
  if (!Array.isArray(steps)) return { entries, stepEndTimes, total: 0 };
  for (
    let stepIndex = 0;
    stepIndex < steps.length && stepIndex < 1000 && entries.length < 10000;
    stepIndex += 1
  ) {
    const step: unknown = steps[stepIndex];
    let stepLength = 0;
    if (Array.isArray(step)) {
      for (let index = 0; index < step.length && entries.length < 10000; index += 1) {
        const source: unknown = step[index];
        if (!source || typeof source !== "object") continue;
        const {
          elementId,
          delayMs,
          durationMs,
          tracks: sourceTracks,
        } = source as Record<string, unknown>;
        if (typeof elementId !== "string" || elementId.length > 1024) continue;
        const tracks: DeckStepTrack[] = [];
        const trackList = Array.isArray(sourceTracks) ? sourceTracks : [];
        for (let trackIndex = 0; trackIndex < trackList.length && trackIndex < 4; trackIndex += 1) {
          const track: unknown = trackList[trackIndex];
          if (!track || typeof track !== "object") continue;
          const { kind, from, to, fromX, fromY, toX, toY } = track as Record<string, unknown>;
          if (kind === "opacity" || kind === "scale") {
            tracks.push({ kind, from: finite(from, 0), to: finite(to, 0) });
          } else if (kind === "translate") {
            tracks.push({
              kind,
              fromX: finite(fromX, 0),
              fromY: finite(fromY, 0),
              toX: finite(toX, 0),
              toY: finite(toY, 0),
            });
          }
        }
        const delay = clampTime(delayMs);
        const duration = clampTime(durationMs);
        const start = cursor + delay;
        const end = start + duration;
        entries.push({
          entry: { elementId, delayMs: delay, durationMs: duration, tracks },
          start,
          end,
        });
        stepLength = Math.max(stepLength, delay + duration);
      }
    }
    cursor += stepLength;
    stepEndTimes.push(cursor);
  }
  return { entries, stepEndTimes, total: cursor };
}

export interface ElementStyle {
  opacity?: number;
  transform?: string;
}

/**
 * Computes the inline styles (opacity, transform) for every animated element at
 * time `t` on the timeline. Opacity interpolates linearly; scale/translate use
 * easeInOutCubic (matching the reference). Scale and translate are never
 * combined into one transform string: each track sets `style.transform`
 * directly, so when an entry has both, the one that appears later in
 * `entry.tracks` simply overwrites the earlier one (matching the reference's
 * plain overwrite-in-iteration-order behavior).
 */
export function sampleStyles(timeline: DeckTimeline, t: number): Map<string, ElementStyle> {
  function easeInOutCubic(x: number): number {
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }

  const styles = new Map<string, ElementStyle>();
  for (const { entry, start, end } of timeline.entries) {
    const duration = end - start;
    const linear =
      duration <= 0 ? (t >= end ? 1 : 0) : Math.min(Math.max((t - start) / duration, 0), 1);
    const eased = easeInOutCubic(linear);

    const style: ElementStyle = styles.get(entry.elementId) ?? {};

    for (const track of entry.tracks) {
      if (track.kind === "opacity") {
        style.opacity = track.from + (track.to - track.from) * linear;
      } else if (track.kind === "scale") {
        const scale = track.from + (track.to - track.from) * eased;
        style.transform = `scale(${scale})`;
      } else if (track.kind === "translate") {
        const x = track.fromX + (track.toX - track.fromX) * eased;
        const y = track.fromY + (track.toY - track.fromY) * eased;
        style.transform = `translate(${x * 100}%, ${y * 100}%)`;
      }
    }

    styles.set(entry.elementId, style);
  }
  return styles;
}

/**
 * Maps a "steps revealed" count (0..steps.length) to a time on the timeline:
 * 0 → nothing revealed (t=0), k → end of step k-1, length → fully revealed.
 */
export function timeForRevealed(timeline: DeckTimeline, stepsRevealed: number): number {
  if (stepsRevealed <= 0) return 0;
  if (stepsRevealed >= timeline.stepEndTimes.length) return timeline.total;
  return timeline.stepEndTimes[stepsRevealed - 1];
}
