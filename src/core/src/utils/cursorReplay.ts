import type { CursorRecordingEvent, MouseCursorPosition, Recording } from "../types";
import type { DeltaFrame } from "./deltaTypes";
import { findFrameIndexAtTime } from "./frameDelta";
import { isKeyframe } from "./deltaTypes";

export type CursorReplaySample = CursorRecordingEvent;

const STATIONARY_HOLD_GAP_MS = 120;
const STATIONARY_HOLD_LEAD_MS = 16;

export interface CursorReplayPositionResult {
  cursor: MouseCursorPosition;
  index: number;
}

const hasFiniteCursorPosition = (cursor: MouseCursorPosition): boolean =>
  Number.isFinite(cursor.x) && Number.isFinite(cursor.y);

const areCursorPositionsEqual = (
  previous: MouseCursorPosition | undefined,
  next: MouseCursorPosition | undefined,
): boolean =>
  Boolean(previous && next) &&
  previous?.x === next?.x &&
  previous?.y === next?.y &&
  previous?.visible === next?.visible;

const appendCursorSample = (
  samples: CursorReplaySample[],
  timestamp: number,
  cursor: MouseCursorPosition | undefined,
): void => {
  if (!cursor || !hasFiniteCursorPosition(cursor)) return;

  const sample = {
    timestamp: Math.max(0, timestamp),
    x: cursor.x,
    y: cursor.y,
    visible: cursor.visible,
  };
  const previousSample = samples[samples.length - 1];

  if (
    previousSample &&
    !areCursorPositionsEqual(previousSample, sample) &&
    sample.timestamp - previousSample.timestamp > STATIONARY_HOLD_GAP_MS
  ) {
    samples.push({
      ...previousSample,
      timestamp: Math.max(previousSample.timestamp, sample.timestamp - STATIONARY_HOLD_LEAD_MS),
    });
  }

  if (areCursorPositionsEqual(samples[samples.length - 1], sample)) {
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
        x: previous.x,
        y: previous.y,
        visible: previous.visible,
      },
      index,
    };
  }

  const duration = next.timestamp - previous.timestamp;
  if (duration <= 0) {
    return {
      cursor: {
        x: previous.x,
        y: previous.y,
        visible: previous.visible,
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
    },
    index,
  };
};
