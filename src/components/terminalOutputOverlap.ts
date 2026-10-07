/**
 * The tail of the text already written that a slid window is searched for:
 * long enough that a match is no coincidence, short enough that the native
 * scan over a 50,000-character window stays in microseconds.
 */
const ANCHOR_LENGTH = 256;
/**
 * Output that repeats one block over and over matches the anchor in many
 * places. Past this many rejected matches, rewriting the window is cheaper.
 */
const MAX_ANCHOR_MATCHES = 8;

/**
 * How much of `next` repeats the end of `previous`, when `next` is `previous`
 * with text dropped off its front and text appended, as a capped log is once
 * it is full. Only `next.slice(overlap)` is new then. Returns -1 when `next`
 * does not continue `previous`, or the two share less than the anchor.
 *
 * Like diffTerminalOutput (runtimeTrack.ts), it prefers the longest overlap,
 * which keeps the appended text minimal, but it finds it with a native scan
 * for the anchor instead of a KMP pass over both strings.
 */
export function findSlidWindowOverlap(previous: string, next: string): number {
  if (previous.length < ANCHOR_LENGTH) {
    return -1;
  }

  const anchor = previous.slice(-ANCHOR_LENGTH);
  // An overlap longer than `previous` is impossible, so later matches are skipped.
  let anchorIndex = next.lastIndexOf(anchor, previous.length - ANCHOR_LENGTH);

  for (let matches = 0; anchorIndex >= 0 && matches < MAX_ANCHOR_MATCHES; matches += 1) {
    const overlap = anchorIndex + ANCHOR_LENGTH;

    if (previous.endsWith(next.slice(0, overlap))) {
      return overlap;
    }

    anchorIndex = anchorIndex > 0 ? next.lastIndexOf(anchor, anchorIndex - 1) : -1;
  }

  return -1;
}
