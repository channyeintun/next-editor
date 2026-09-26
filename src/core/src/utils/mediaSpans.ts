// ============================================================================
// Spans of a take's media timeline.
//
// A retake discards everything its recorders captured since the safe point it
// rewinds to. The microphone and camera keep running across that (paused), so
// their files hold the discarded stretch: these spans, in media time, say what
// to drop. Narration is cut for real when the take loads; the camera is mapped
// around the spans as it plays (see mapRecordingTimeToMediaTime).
// ============================================================================

/** A half-open span `[start, end)` in milliseconds. */
export interface MediaSpan {
  start: number;
  end: number;
}

/**
 * Sorted, non-overlapping, non-empty spans (touching spans are merged). Anything that
 * is not a span of finite numbers is dropped, so a file's header can be passed as is.
 */
export function normalizeMediaSpans(spans: readonly unknown[]): MediaSpan[] {
  const sorted = spans
    .filter(
      (span): span is MediaSpan =>
        typeof span === "object" &&
        span !== null &&
        Number.isFinite((span as MediaSpan).start) &&
        Number.isFinite((span as MediaSpan).end),
    )
    .map((span) => ({ start: Math.max(0, span.start), end: Math.max(0, span.end) }))
    .filter((span) => span.end > span.start)
    .sort((left, right) => left.start - right.start);

  const merged: MediaSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

export function totalMediaSpanLength(spans: readonly MediaSpan[]): number {
  let total = 0;
  for (const span of spans) total += span.end - span.start;
  return total;
}

/**
 * Adds a retake's discarded span. Everything recorded at or after its start was
 * discarded with it, so later spans are folded into it.
 */
export function addMediaCut(cuts: readonly MediaSpan[], cut: MediaSpan): MediaSpan[] {
  return normalizeMediaSpans([...cuts.filter((existing) => existing.start < cut.start), cut]);
}

/**
 * Where recorded time `time` falls on the uncut media timeline: every cut at or
 * before that point is skipped over. `cuts` must be normalized.
 */
export function mapRecordingTimeToMediaTime(time: number, cuts: readonly MediaSpan[]): number {
  let mediaTime = time;
  for (const cut of cuts) {
    if (cut.start > mediaTime) break;
    mediaTime += cut.end - cut.start;
  }
  return mediaTime;
}
