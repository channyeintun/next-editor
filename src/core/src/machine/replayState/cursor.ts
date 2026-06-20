// ============================================================================
// Replay cursor core.
//
// Shared, track-agnostic helpers for turning "what time are we at?" into "which
// event index applies now". Each per-track replay module (preview/workspace/
// runtime/slide) builds on these. Lookup is optimized for forward playback: a
// short linear scan from the last index, falling back to binary search on seeks.
// ============================================================================

export type ReplayTriggerEvent = {
  type: string;
  currentTime?: number;
  time?: number;
};

export interface TimedReplayEvent {
  timestamp: number;
}

export interface ReplayCursorResult<T extends TimedReplayEvent> {
  latestEvent: T | null;
  nextIndex: number;
}

const LINEAR_SCAN_LIMIT = 128;

export function resolveReplayTime(event: ReplayTriggerEvent, fallbackTime: number): number {
  if (event.type === "TICK") {
    return event.currentTime ?? fallbackTime;
  }

  if (event.type === "SEEK") {
    return event.time ?? fallbackTime;
  }

  return fallbackTime;
}

export function isSeekReplayEvent(event: ReplayTriggerEvent): boolean {
  return event.type === "SEEK";
}

export function advanceReplayCursor<T extends TimedReplayEvent>({
  events,
  currentTime,
  lastAppliedIndex,
}: {
  events: T[];
  currentTime: number;
  lastAppliedIndex: number;
}): ReplayCursorResult<T> {
  const nextIndex = findTimedEventIndexAtOrBefore(events, currentTime, lastAppliedIndex);
  const latestEvent = nextIndex >= 0 ? events[nextIndex] : null;

  return {
    latestEvent,
    nextIndex,
  };
}

export function findTimedEventIndexAtOrBefore<T extends TimedReplayEvent>(
  events: T[],
  currentTime: number,
  startIndex: number,
): number {
  if (!events.length) {
    return -1;
  }

  const lastIndex = events.length - 1;
  const hasValidStartIndex = startIndex >= 0 && startIndex <= lastIndex;

  if (!hasValidStartIndex) {
    return findTimedEventIndexAtOrBeforeBinary(events, currentTime, 0, lastIndex);
  }

  if (events[startIndex].timestamp > currentTime) {
    return findTimedEventIndexAtOrBeforeBinary(events, currentTime, 0, startIndex);
  }

  if (startIndex === lastIndex || events[startIndex + 1].timestamp > currentTime) {
    return startIndex;
  }

  const scanEnd = Math.min(lastIndex, startIndex + LINEAR_SCAN_LIMIT);

  for (let index = startIndex + 1; index <= scanEnd; index++) {
    if (events[index].timestamp > currentTime) {
      return index - 1;
    }
  }

  if (scanEnd === lastIndex) {
    return lastIndex;
  }

  return findTimedEventIndexAtOrBeforeBinary(events, currentTime, scanEnd, lastIndex);
}

function findTimedEventIndexAtOrBeforeBinary<T extends TimedReplayEvent>(
  events: T[],
  currentTime: number,
  low: number,
  high: number,
): number {
  let nearestIndex = low > 0 ? low - 1 : -1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);

    if (events[mid].timestamp <= currentTime) {
      nearestIndex = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return nearestIndex;
}
