import type {
  CursorRecordingEvent,
  CursorTargetSnapshot,
  CursorTweenEndpoint,
  CursorTweenSnapshot,
  MouseCursorPosition,
  Recording,
} from "../types";
import type { DeltaFrame } from "./deltaTypes";
import { findFrameIndexAtTime } from "./frameDelta";
import { isKeyframe } from "./deltaTypes";
import { areMouseCursorPositionsEqual } from "./cursorCoordinates";

export type CursorReplaySample = CursorRecordingEvent;

// Longer than any real cursor glide: pointer motion is sampled every ~16–50ms,
// so even a slow, deliberate move has dense samples. A gap beyond this with no
// samples between two *different* positions means the cursor was parked between
// gestures, not gliding across the whole gap. (Recorded holds dedup to a single
// sample, so a long same-position gap tweens to itself and is unaffected; this
// only changes synthetic tracks like the studio's, which record the end of one
// gesture and the start of the next far apart.)
const IDLE_HOLD_THRESHOLD_MS = 1000;

// Across such a gap the cursor holds at the previous position, then glides to
// the next over this final window so it arrives from where it was exactly as the
// next gesture begins — a real transition, never a slow drift across the whole
// gap nor a jump out of nowhere.
const IDLE_TRANSITION_MS = 500;

// From-rest reposition easing: accelerate off the parked spot, settle onto the
// target. Local to keep core independent of the studio's cadence helpers.
const easeInOutReposition = (t: number): number => {
  const c = Math.min(1, Math.max(0, t));
  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2;
};

export interface CursorReplayPositionResult {
  cursor: MouseCursorPosition;
  index: number;
}

const hasFiniteCursorPosition = (cursor: MouseCursorPosition): boolean =>
  Number.isFinite(cursor.x) && Number.isFinite(cursor.y);

const copyCursorTarget = (
  target: CursorTargetSnapshot | undefined,
): CursorTargetSnapshot | undefined =>
  target
    ? {
        id: target.id,
        x: target.x,
        y: target.y,
        rect: {
          left: target.rect.left,
          top: target.rect.top,
          width: target.rect.width,
          height: target.rect.height,
        },
      }
    : undefined;

const copyCursorTweenEndpoint = (cursor: MouseCursorPosition): CursorTweenEndpoint => {
  const target = copyCursorTarget(cursor.target);

  return {
    x: cursor.x,
    y: cursor.y,
    visible: cursor.visible,
    ...(cursor.coordinateSpace ? { coordinateSpace: cursor.coordinateSpace } : {}),
    ...(target ? { target } : {}),
  };
};

const copyCursorTween = (tween: CursorTweenSnapshot | undefined): CursorTweenSnapshot | undefined =>
  tween
    ? {
        from: {
          x: tween.from.x,
          y: tween.from.y,
          visible: tween.from.visible,
          ...(tween.from.coordinateSpace ? { coordinateSpace: tween.from.coordinateSpace } : {}),
          ...(tween.from.target ? { target: copyCursorTarget(tween.from.target) } : {}),
        },
        to: {
          x: tween.to.x,
          y: tween.to.y,
          visible: tween.to.visible,
          ...(tween.to.coordinateSpace ? { coordinateSpace: tween.to.coordinateSpace } : {}),
          ...(tween.to.target ? { target: copyCursorTarget(tween.to.target) } : {}),
        },
        progress: tween.progress,
      }
    : undefined;

const copyCursorPosition = (cursor: MouseCursorPosition): MouseCursorPosition => {
  const target = copyCursorTarget(cursor.target);
  const tween = copyCursorTween(cursor.tween);

  return {
    x: cursor.x,
    y: cursor.y,
    visible: cursor.visible,
    ...(cursor.coordinateSpace ? { coordinateSpace: cursor.coordinateSpace } : {}),
    ...(typeof cursor.flags === "number" ? { flags: cursor.flags } : {}),
    ...(cursor.hover !== undefined ? { hover: cursor.hover } : {}),
    ...(typeof cursor.angle === "number" ? { angle: cursor.angle } : {}),
    ...(typeof cursor.pressure === "number" ? { pressure: cursor.pressure } : {}),
    ...(target ? { target } : {}),
    ...(tween ? { tween } : {}),
  };
};

const appendCursorSample = (
  samples: CursorReplaySample[],
  timestamp: number,
  cursor: MouseCursorPosition | undefined,
): void => {
  if (!cursor || !hasFiniteCursorPosition(cursor)) return;

  const sample: CursorReplaySample = {
    timestamp: Math.max(0, timestamp),
    ...copyCursorPosition(cursor),
  };

  if (areMouseCursorPositionsEqual(samples[samples.length - 1], sample)) {
    return;
  }

  samples.push(sample);
};

const normalizeCursorEvents = (events: CursorRecordingEvent[]): CursorReplaySample[] => {
  const samples: CursorReplaySample[] = [];

  events
    .filter((event) => Number.isFinite(event.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp)
    .forEach((event) => {
      appendCursorSample(samples, event.timestamp, event);
    });

  return samples;
};

export const deriveCursorSamplesFromFrames = (frames: DeltaFrame[]): CursorReplaySample[] => {
  const samples: CursorReplaySample[] = [];

  frames.forEach((frame) => {
    if (isKeyframe(frame)) {
      appendCursorSample(samples, frame.timestamp, frame.state.mouseCursor);
      return;
    }

    if (frame.mouseCursor !== undefined) {
      appendCursorSample(samples, frame.timestamp, frame.mouseCursor);
    }
  });

  return samples;
};

export const getCursorReplaySamples = (recording: Recording): CursorReplaySample[] => {
  if (recording.cursorEvents?.length) {
    return normalizeCursorEvents(recording.cursorEvents);
  }

  return deriveCursorSamplesFromFrames(recording.frames);
};

export const getCursorPositionAtTime = (
  samples: CursorReplaySample[],
  time: number,
  startIndex = 0,
): CursorReplayPositionResult | null => {
  if (!samples.length) return null;

  const index = findFrameIndexAtTime(samples, time, startIndex);
  const previous = samples[index];
  const next = samples[index + 1];

  if (!previous) return null;

  if (!next || !previous.visible || !next.visible || previous.visible !== next.visible) {
    return {
      cursor: {
        ...copyCursorPosition(previous),
      },
      index,
    };
  }

  const duration = next.timestamp - previous.timestamp;
  if (duration <= 0) {
    return {
      cursor: {
        ...copyCursorPosition(previous),
      },
      index,
    };
  }

  // Across a long idle gap the cursor was parked between gestures: hold at
  // `previous` through the idle, then glide to `next` only over the final
  // IDLE_TRANSITION_MS, so it arrives from where it was exactly as the next
  // gesture begins — not a slow drift across the whole gap, and not a jump. The
  // gradual target keeps the on-screen cursor easing smoothly (Cursor.tsx snaps
  // only on large per-frame jumps). Shorter gaps interpolate across their span.
  const progress =
    duration > IDLE_HOLD_THRESHOLD_MS
      ? easeInOutReposition((time - (next.timestamp - IDLE_TRANSITION_MS)) / IDLE_TRANSITION_MS)
      : Math.min(1, Math.max(0, (time - previous.timestamp) / duration));

  return {
    cursor: {
      x: previous.x + (next.x - previous.x) * progress,
      y: previous.y + (next.y - previous.y) * progress,
      visible: true,
      ...(previous.coordinateSpace === next.coordinateSpace && previous.coordinateSpace
        ? { coordinateSpace: previous.coordinateSpace }
        : {}),
      ...(typeof next.flags === "number" ? { flags: next.flags } : {}),
      ...((progress < 1 ? previous.hover : next.hover) !== undefined
        ? { hover: progress < 1 ? previous.hover : next.hover }
        : {}),
      ...(typeof next.angle === "number" ? { angle: next.angle } : {}),
      ...(typeof next.pressure === "number" ? { pressure: next.pressure } : {}),
      tween: {
        from: copyCursorTweenEndpoint(previous),
        to: copyCursorTweenEndpoint(next),
        progress,
      },
    },
    index,
  };
};
