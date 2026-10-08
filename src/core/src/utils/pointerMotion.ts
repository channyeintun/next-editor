/**
 * How a hand moves a pointer, measured from real recordings rather than
 * guessed: the bundled introduction lesson (a person pointing, clicking and
 * drag-selecting in the editor) and a 52-minute screencast with 47 text
 * drag-selects, both decoded 2026-10-08. The studio's synthetic pointer and
 * the replay's between-gesture glide both move by these rules, so a learner
 * sees one consistent hand.
 *
 * - A move toward a target is one straight stroke (sideways bow ≈ 3% of the
 *   distance) that starts and ends at rest and reaches its top speed a little
 *   before halfway — time-to-peak ≈ 0.4–0.47 of the move — so it spends longer
 *   settling onto the target than leaving the old one. No arc, overshoot or
 *   tremor to imitate: those were rare and read as noise.
 * - Its duration barely grows with distance; peak speed does the scaling. The
 *   whole approach took ≈ 98·D^0.3 ms (≈ 390 / 540 / 670 / 780 ms at
 *   100 / 300 / 600 / 1000 px).
 * - The hand arrives, rests ≈ 220–340 ms, then presses.
 * - A drag-select starts from rest after the press, peaks early (≈ 0.2–0.33 of
 *   the drag) and decelerates onto the last character — the recordings reach
 *   .35 / .71 / .91 of the distance at 25 / 50 / 75% of the drag time.
 *   easePointerDrag keeps that early peak (1/3) and the rest-to-rest ends but
 *   is a smooth closed form, not a quantile fit: it reaches .26 / .69 / .95, a
 *   slower start and a later landing than the recorded .35 / .71 / .91. The
 *   curve, not the recorded quantiles, is what the studio's drag-selects
 *   follow, and so what a learner sees replayed.
 */

const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));

/**
 * Aimed move: speed ∝ t²(1−t)³ — leaves at rest, peaks at 40% of the move,
 * settles onto the target at rest. (The regularized Beta(3,4) CDF.)
 */
export function easePointerAim(t: number): number {
  const c = clamp01(t);
  const c3 = c * c * c;
  return c3 * (20 - 45 * c + 36 * c * c - 10 * c3);
}

/**
 * Drag after the press: speed ∝ t(1−t)² — starts from rest, peaks a third of
 * the way in, then a long careful landing on the last character. Reaches
 * .26 / .69 / .95 of the distance at 25 / 50 / 75% of the time. (The
 * regularized Beta(2,3) CDF.)
 */
export function easePointerDrag(t: number): number {
  const c = clamp01(t);
  return 1 - (1 - c) ** 3 * (1 + 3 * c);
}

export const POINTER_AIM_MIN_MS = 220;
export const POINTER_AIM_MAX_MS = 800;

/** Time a hand takes to bring the pointer `distancePx` onto a target (0 for no distance). */
export function pointerAimDurationMs(distancePx: number): number {
  if (!(distancePx > 0)) return 0;
  return Math.round(
    Math.min(POINTER_AIM_MAX_MS, Math.max(POINTER_AIM_MIN_MS, 98 * distancePx ** 0.3)),
  );
}

/** Rest between arriving on a target and pressing it. */
export const POINTER_SETTLE_MS = 220;

/** How long a click holds the button down. */
export const POINTER_PRESS_MS = 100;
