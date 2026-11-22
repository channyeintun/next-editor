import { useEffect, useState, type CSSProperties } from "react";

/** The play triangle, starting at its right tip and running clockwise round to it again. */
const TRIANGLE_PATH =
  "M240,128a15.74,15.74,0,0,1-7.6,13.51L88.32,229.65a16,16,0,0,1-16.2.3A15.86,15.86,0,0,1,64,216.13V39.87a15.86,15.86,0,0,1,8.12-13.82,16,16,0,0,1,16.2.3L232.4,114.49A15.74,15.74,0,0,1,240,128Z";

/** How long the border takes to reach a real step (lessonStart.css): the drift waits for it. */
const STEP_TRANSITION_MS = 250;

interface ProgressTriangleProps {
  /** The triangle's box, in CSS pixels. */
  size: number;
  /** Which trace this is: a new number draws a new border from the start point. */
  trace: number;
  /** How much of the border is traced, 0 to 1. */
  value: number;
  /** Where the border may drift to while it waits for its next real step. */
  drift: number;
  /** Filled: the lesson is ready to play. */
  solid: boolean;
}

/**
 * Whether the border may drift on from `value`: once it has been drawn there. The step
 * to a real value is a short transition and the drift a long one, and a transition
 * needs the border to have been painted where it starts from.
 */
function useDriftsFrom(trace: number, value: number, drift: number): boolean {
  const step = `${trace}:${value}`;
  const [driftingFrom, setDriftingFrom] = useState<string | null>(null);

  useEffect(() => {
    if (drift <= value) return;
    // An empty border has no step to finish drawing: one painted frame is enough.
    const timer = setTimeout(() => setDriftingFrom(step), value === 0 ? 32 : STEP_TRANSITION_MS);
    return () => clearTimeout(timer);
  }, [step, value, drift]);

  return drift > value && driftingFrom === step;
}

/**
 * The play triangle with a progress border: a faint track round it, and over the track
 * the part of it that is traced so far. The numbers arrive as custom properties and
 * the stylesheet moves the border, so nothing here runs per frame.
 */
export default function ProgressTriangle({
  size,
  trace,
  value,
  drift,
  solid,
}: ProgressTriangleProps) {
  const drifting = useDriftsFrom(trace, value, drift);

  return (
    <svg
      viewBox="0 0 256 256"
      width={size}
      height={size}
      className="lesson-start__glyph"
      data-solid={solid || undefined}
      style={{ "--trace-value": value, "--trace-drift": drift } as CSSProperties}
      aria-hidden="true"
    >
      <path d={TRIANGLE_PATH} className="lesson-start__fill" />
      <path d={TRIANGLE_PATH} className="lesson-start__track" />
      {/* Keyed by its trace: a new wait is a new element, drawn from the start point,
          not the last border run backward. */}
      <path
        key={trace}
        d={TRIANGLE_PATH}
        pathLength={100}
        className="lesson-start__trace"
        data-drifting={drifting || undefined}
        data-empty={(value <= 0 && !drifting) || undefined}
      />
    </svg>
  );
}
