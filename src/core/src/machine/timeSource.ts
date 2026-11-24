// ============================================================================
// Where a take reads time.
//
// A recording stamps everything on one clock: `perfNow()` since the take
// started, with pauses removed (recordingClock.ts). By default that clock is
// the page's own. A caller that performs a take itself, and knows every wait
// in it, can hand the take another source and so decide how fast recorded
// time passes; the studio does this for lessons it can perform without real
// frames (src/studio/renderClock.ts).
//
// The source covers the take's own time only: its origin, every recorded
// timestamp, and the pause, resume and chapter anchors. A microphone, a
// camera, a screen capture and a narration element that plays are real-time
// devices and keep the page's clock, so a take that uses one of them keeps
// the default source: the start's source is ignored (captureActions.ts).
// ============================================================================

export interface TimeSource {
  /** Monotonic milliseconds, in the unit and origin of `performance.now()`. */
  perfNow(): number;
  /** Wall-clock milliseconds, in the unit of `Date.now()`, moving together with `perfNow`. */
  wallNow(): number;
}

/**
 * The page's own clock. It reads the globals at call time, not at import
 * time, so a test that pins `performance.now` or `Date.now` pins this too.
 */
export const SYSTEM_TIME_SOURCE: TimeSource = {
  perfNow: () => performance.now(),
  wallNow: () => Date.now(),
};
