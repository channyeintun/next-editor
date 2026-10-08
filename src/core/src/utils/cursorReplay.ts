import type {
  CursorRecordingEvent,
  CursorTargetSnapshot,
  CursorTweenEndpoint,
  CursorTweenSnapshot,
  MouseCursorPosition,
  Recording,
} from "../types";
import type { DeltaFrame } from "./deltaTypes";
import { findTimedEventIndexAtOrBefore } from "./timedIndex";
import { isKeyframe } from "./deltaTypes";
import { areMouseCursorPositionsEqual } from "./cursorCoordinates";
import { POINTER_SETTLE_MS, easePointerAim, pointerAimDurationMs } from "./pointerMotion";

// Pointer events arrive every ~16–17ms while a hand moves (60 Hz; the p90 gap
// in a 52-minute human recording was 34ms) and not at all while it rests. A gap
// wider than this between two samples means the pointer was parked at the
// first one, not crawling across the whole gap — on a human recording a rest
// before the next movement, on the studio's a gesture's end and the next one's
// start, seconds of narration apart.
const SPARSE_GAP_MS = 100;

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
        ...(target.cell ? { cell: { ...target.cell } } : {}),
      }
    : undefined;

const copyCursorTweenEndpoint = (cursor: CursorTweenEndpoint): CursorTweenEndpoint => {
  const target = copyCursorTarget(cursor.target);

  return {
    x: cursor.x,
    y: cursor.y,
    visible: cursor.visible,
    ...(cursor.coordinateSpace ? { coordinateSpace: cursor.coordinateSpace } : {}),
    ...(target ? { target } : {}),
  };
};

const copyCursorTween = (
  tween: CursorTweenSnapshot | undefined,
): CursorTweenSnapshot | undefined =>
  tween
    ? {
        from: copyCursorTweenEndpoint(tween.from),
        to: copyCursorTweenEndpoint(tween.to),
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
  samples: CursorRecordingEvent[],
  timestamp: number,
  cursor: MouseCursorPosition | undefined,
): void => {
  if (!cursor || !hasFiniteCursorPosition(cursor)) return;

  const sample: CursorRecordingEvent = {
    timestamp: Math.max(0, timestamp),
    ...copyCursorPosition(cursor),
  };

  if (areMouseCursorPositionsEqual(samples[samples.length - 1], sample)) {
    return;
  }

  samples.push(sample);
};

// Recordings made before mouseTrackingActor's `isPageBoundaryLeave` fix carry a
// hidden {0,0} sample every time the pointer crossed out of *any* element while
// it never left the page — in the bundled introduction lesson, one ~1ms before
// nearly every move sample (562 of them), and a dozen while it rested, which
// blank the pointer until the hand next moves (up to 7.6s). The pointer was
// there all along: it shows again within a frame, or a few pixels from where
// it vanished, mid-page. A real exit leaves across a window edge and comes
// back later somewhere else, so it is kept.
const STRAY_LEAVE_RETURN_MS = 50;
const STRAY_LEAVE_RETURN_PX = 48;
// One exception keeps its hide: a leave logged as a slide or whiteboard opened
// over a resting pointer that then stayed off the mouse until the panel closed
// (or for seconds). That is an older studio render's pointer going out of
// sight under the panel — what the studio now does on purpose — not a blink.
const OVERLAY_LEAVE_MS = 150;
const HANDS_OFF_MS = 2_000;

interface OverlaySpan {
  open: number;
  close: number;
}

// When a slide or the whiteboard covered the stage. An overlay never closed
// stays open to the end.
const overlaySpansOf = (recording: Recording): OverlaySpan[] => {
  const spans: OverlaySpan[] = [];
  const track = (events: { timestamp: number; open: boolean | undefined }[]) => {
    let openedAt: number | null = null;
    for (const event of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
      if (event.open === true && openedAt === null) {
        openedAt = event.timestamp;
      } else if (event.open === false && openedAt !== null) {
        spans.push({ open: openedAt, close: event.timestamp });
        openedAt = null;
      }
    }
    if (openedAt !== null) spans.push({ open: openedAt, close: Number.POSITIVE_INFINITY });
  };
  track(
    (recording.slideEvents ?? []).map((event) => ({
      timestamp: event.timestamp,
      open: event.type === "slide_open" ? true : event.type === "slide_close" ? false : undefined,
    })),
  );
  track(
    (recording.whiteboardEvents ?? []).map((event) => ({
      timestamp: event.timestamp,
      open: event.isOpen,
    })),
  );
  return spans;
};

const isOverlayLeave = (
  sample: CursorRecordingEvent,
  next: CursorRecordingEvent,
  overlays: readonly OverlaySpan[],
): boolean =>
  overlays.some(
    (span) =>
      sample.timestamp >= span.open &&
      sample.timestamp - span.open <= OVERLAY_LEAVE_MS &&
      (next.timestamp >= span.close || next.timestamp - sample.timestamp > HANDS_OFF_MS),
  );

const isStrayLeaveSample = (
  previous: CursorRecordingEvent | undefined,
  sample: CursorRecordingEvent,
  next: CursorRecordingEvent | undefined,
  overlays: readonly OverlaySpan[],
): boolean =>
  !sample.visible &&
  sample.x === 0 &&
  sample.y === 0 &&
  !sample.target &&
  previous !== undefined &&
  next !== undefined &&
  previous.visible &&
  next.visible &&
  !isOverlayLeave(sample, next, overlays) &&
  (next.timestamp - sample.timestamp <= STRAY_LEAVE_RETURN_MS ||
    (previous.coordinateSpace === next.coordinateSpace &&
      Math.hypot(next.x - previous.x, next.y - previous.y) <= STRAY_LEAVE_RETURN_PX));

const normalizeCursorEvents = (
  events: CursorRecordingEvent[],
  overlays: readonly OverlaySpan[] = [],
): CursorRecordingEvent[] => {
  const samples: CursorRecordingEvent[] = [];
  const ordered = events
    .filter((event) => Number.isFinite(event.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);

  ordered.forEach((event, index) => {
    if (isStrayLeaveSample(samples[samples.length - 1], event, ordered[index + 1], overlays)) {
      return;
    }
    appendCursorSample(samples, event.timestamp, event);
  });

  return samples;
};

const deriveCursorSamplesFromFrames = (frames: DeltaFrame[]): CursorRecordingEvent[] => {
  const samples: CursorRecordingEvent[] = [];

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

export const getCursorReplaySamples = (recording: Recording): CursorRecordingEvent[] => {
  if (recording.cursorEvents?.length) {
    return normalizeCursorEvents(recording.cursorEvents, overlaySpansOf(recording));
  }

  return deriveCursorSamplesFromFrames(recording.frames);
};

// `progress` of the way from `previous` to `next`, as a tween the renderer
// resolves endpoint by endpoint (each may be relative to a different target).
const blendCursors = (
  previous: CursorRecordingEvent,
  next: CursorRecordingEvent,
  progress: number,
  flags: number | undefined,
): MouseCursorPosition => {
  const hover = progress < 1 ? previous.hover : next.hover;
  return {
    x: previous.x + (next.x - previous.x) * progress,
    y: previous.y + (next.y - previous.y) * progress,
    visible: true,
    ...(previous.coordinateSpace === next.coordinateSpace && previous.coordinateSpace
      ? { coordinateSpace: previous.coordinateSpace }
      : {}),
    ...(typeof flags === "number" ? { flags } : {}),
    ...(hover !== undefined ? { hover } : {}),
    ...(typeof next.angle === "number" ? { angle: next.angle } : {}),
    ...(typeof next.pressure === "number" ? { pressure: next.pressure } : {}),
    tween: {
      from: copyCursorTweenEndpoint(previous),
      to: copyCursorTweenEndpoint(next),
      progress,
    },
  };
};

export const getCursorPositionAtTime = (
  samples: CursorRecordingEvent[],
  time: number,
  startIndex = 0,
): CursorReplayPositionResult | null => {
  if (!samples.length) return null;

  // Before the first sample, hold the first one (samples is non-empty here).
  const index = Math.max(0, findTimedEventIndexAtOrBefore(samples, time, startIndex));
  const previous = samples[index];
  const next = samples[index + 1];

  if (!previous) return null;

  // Hold at `previous` when there is nothing to glide to: no next sample, a
  // hidden cursor on either side, or samples that share a timestamp.
  const duration = next ? next.timestamp - previous.timestamp : 0;
  if (!next || !previous.visible || !next.visible || duration <= 0) {
    return { cursor: copyCursorPosition(previous), index };
  }

  // The button state is a step: it holds from the sample where it changed
  // until the next one. A tap's [press, release) — 13ms on a trackpad — reads
  // as pressed, and the stroke into a press does not.
  if (duration <= SPARSE_GAP_MS) {
    // Dense samples of one continuous movement: interpolate across the span.
    const progress = Math.min(1, Math.max(0, (time - previous.timestamp) / duration));
    return { cursor: blendCursors(previous, next, progress, previous.flags), index };
  }

  // A parked pointer: hold at `previous`, then make the approach a hand makes —
  // a straight move timed by its distance that leaves and lands at rest, ending
  // a beat *before* the next gesture so the pointer settles on its target
  // before pressing (recorded hands rest ~220–340ms there). Not a slow drift
  // across the whole gap, and not a jump.
  const distance = Math.hypot(next.x - previous.x, next.y - previous.y);
  const glideMs = Math.min(duration, pointerAimDurationMs(distance));
  const settleMs = Math.min(POINTER_SETTLE_MS, duration - glideMs);
  const glideStart = next.timestamp - settleMs - glideMs;
  // No distance, no move: stay on `previous` — the spot as it was recorded
  // against the element under it then — until `next` takes over at its own
  // time. Switching early would place the arrow against `next`'s element
  // before replay has laid that element out the way it was recorded (a dock
  // that has not opened yet), throwing it off by the dock's height.
  const progress = glideMs > 0 ? easePointerAim((time - glideStart) / glideMs) : 0;
  return { cursor: blendCursors(previous, next, progress, previous.flags), index };
};
