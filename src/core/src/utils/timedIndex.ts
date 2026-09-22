// ============================================================================
// Timestamp → index lookup shared by every replay track and by editor frames.
//
// Optimized for forward playback: a short linear scan from the last index,
// falling back to binary search on seeks.
// ============================================================================

export interface TimedReplayEvent {
  timestamp: number;
}

const LINEAR_SCAN_LIMIT = 128;

/**
 * Index of the last event whose timestamp is at or before `currentTime`, or -1
 * when every event is later. `startIndex` is the caller's last result; an
 * out-of-range one (such as -1) searches the whole array.
 */
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
