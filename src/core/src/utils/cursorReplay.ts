import type {
  CursorRecordingEvent,
  CursorTargetRect,
  CursorTargetSnapshot,
  MouseCursorPosition,
  Recording,
} from "../types";
import type { DeltaFrame } from "./deltaTypes";
import { findFrameIndexAtTime } from "./frameDelta";
import { isKeyframe } from "./deltaTypes";
import { areMouseCursorPositionsEqual } from "./cursorCoordinates";

export type CursorReplaySample = CursorRecordingEvent;

const STATIONARY_HOLD_GAP_MS = 120;
const STATIONARY_HOLD_LEAD_MS = 16;

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

const copyCursorPosition = (cursor: MouseCursorPosition): MouseCursorPosition => ({
  x: cursor.x,
  y: cursor.y,
  visible: cursor.visible,
  target: copyCursorTarget(cursor.target),
});

const interpolateNumber = (start: number, end: number, progress: number): number =>
  start + (end - start) * progress;

const interpolateTargetRect = (
  previous: CursorTargetRect,
  next: CursorTargetRect,
  progress: number,
): CursorTargetRect => ({
  left: interpolateNumber(previous.left, next.left, progress),
  top: interpolateNumber(previous.top, next.top, progress),
  width: interpolateNumber(previous.width, next.width, progress),
  height: interpolateNumber(previous.height, next.height, progress),
});

const interpolateCursorTarget = (
  previous: CursorTargetSnapshot | undefined,
  next: CursorTargetSnapshot | undefined,
  progress: number,
): CursorTargetSnapshot | undefined => {
  if (!previous || !next || previous.id !== next.id) {
    return undefined;
  }

  return {
    id: previous.id,
    x: interpolateNumber(previous.x, next.x, progress),
    y: interpolateNumber(previous.y, next.y, progress),
    rect: interpolateTargetRect(previous.rect, next.rect, progress),
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
  const previousSample = samples[samples.length - 1];

  if (
    previousSample &&
    !areMouseCursorPositionsEqual(previousSample, sample) &&
    sample.timestamp - previousSample.timestamp > STATIONARY_HOLD_GAP_MS
  ) {
    samples.push({
      ...previousSample,
      target: copyCursorTarget(previousSample.target),
      timestamp: Math.max(previousSample.timestamp, sample.timestamp - STATIONARY_HOLD_LEAD_MS),
    });
  }

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

  const progress = Math.min(1, Math.max(0, (time - previous.timestamp) / duration));

  return {
    cursor: {
      x: previous.x + (next.x - previous.x) * progress,
      y: previous.y + (next.y - previous.y) * progress,
      visible: true,
      target: interpolateCursorTarget(previous.target, next.target, progress),
    },
    index,
  };
};
