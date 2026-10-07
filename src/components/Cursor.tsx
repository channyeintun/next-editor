import React, { useEffect, useRef, useState } from "react";
import { NextEditorActorContext } from "../contexts/NextEditorActorContext";
import { selectIsPlaying, selectRecording } from "../core/src/useNextEditor";
import { resolveCursorViewportPosition } from "../core/src/utils/cursorCoordinates";
import { getCursorPositionAtTime, getCursorReplaySamples } from "../core/src/utils/cursorReplay";
import IconCursor from "./icon/IconCursor";
import {
  isRecordedCursorVisibilityDetail,
  RECORDED_CURSOR_VISIBILITY_EVENT,
} from "../utils/recordedCursorVisibility";

// Where the arrow's tip sits inside the 24px glyph box (viewBox 14,6.5 of 48).
// Press feedback scales and ripples around this point, never the box centre.
const CURSOR_HOTSPOT = { x: 7, y: 3 };
const CURSOR_PRESSED_SCALE = 0.86;
const CURSOR_RING_RADIUS = 14;
const CURSOR_RING_MS = 320;
// A tap shorter than a frame still shows pressed for this long.
const CURSOR_TAP_HOLD_MS = 120;
// Frames closer than this, moving forward, are continuous playback; anything
// else is a seek or a resume.
const CONTINUOUS_PLAYBACK_MS = 250;

const isButtonDown = (cursor: { flags?: number } | undefined): boolean =>
  ((cursor?.flags ?? 0) & 1) === 1;

const prefersReducedMotion = (): boolean =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * CursorComponent - Displays a fake cursor overlay during playback.
 *
 * It draws the replayed position as-is: `getCursorPositionAtTime` already
 * eases every movement, so smoothing it again here would only make the arrow
 * trail the selection it is dragging. A held button (a click, or the drag of a
 * drag-select) shows as a slightly pressed arrow, and each press sends one
 * ring out from the tip so a click on a file or the Run button reads as a
 * click — just the pressed arrow under reduced motion.
 */
const CursorComponent: React.FC<{
  hasParent?: boolean;
}> = ({ hasParent }) => {
  const actorRef = NextEditorActorContext.useActorRef();
  const isPlaying = NextEditorActorContext.useSelector(selectIsPlaying);
  const recording = NextEditorActorContext.useSelector(selectRecording);
  const cursorRef = useRef<HTMLDivElement>(null);
  const glyphRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const [isCursorSuppressed, setIsCursorSuppressed] = useState(false);
  const cursorSamples = recording ? getCursorReplaySamples(recording) : [];

  useEffect(() => {
    const handleRecordedCursorVisibility = (event: Event) => {
      if (!(event instanceof CustomEvent) || !isRecordedCursorVisibilityDetail(event.detail)) {
        return;
      }
      // The studio hides its own recorded pointer through this event while it
      // performs a lesson (typing, a slide over the code). That is a recording
      // instruction, not a viewer hiding the replayed arrow, so a hide outside
      // playback must not leave the next playback without one.
      if (!event.detail.visible && !selectIsPlaying(actorRef.getSnapshot())) {
        return;
      }

      setIsCursorSuppressed(!event.detail.visible);
    };

    window.addEventListener(RECORDED_CURSOR_VISIBILITY_EVENT, handleRecordedCursorVisibility);
    return () => {
      window.removeEventListener(RECORDED_CURSOR_VISIBILITY_EVENT, handleRecordedCursorVisibility);
    };
  }, [actorRef]);

  useEffect(() => {
    const element = cursorRef.current;
    const glyph = glyphRef.current;
    const ring = ringRef.current;
    if (
      !isPlaying ||
      isCursorSuppressed ||
      !element ||
      !glyph ||
      !ring ||
      cursorSamples.length === 0
    ) {
      return;
    }

    let animationFrameId = 0;
    let cursorSampleIndex = 0;
    let isPressedGlyph = false;
    // Where the previous frame was, to tell a press crossed during playback
    // from a seek or a resume landing mid-press.
    let lastIndex: number | null = null;
    let lastTime = Number.NaN;
    let pressedUntil = Number.NEGATIVE_INFINITY;
    const reducedMotion = prefersReducedMotion();
    glyph.style.transition = reducedMotion ? "" : "transform 80ms ease-out";

    const showPressed = (pressed: boolean) => {
      if (pressed === isPressedGlyph) return;
      isPressedGlyph = pressed;
      glyph.style.transform = pressed ? `scale(${CURSOR_PRESSED_SCALE})` : "";
    };

    const ripple = () => {
      if (reducedMotion || typeof ring.animate !== "function") return;
      ring.animate(
        [
          { transform: "scale(0.35)", opacity: 0.6 },
          { transform: "scale(1)", opacity: 0 },
        ],
        { duration: CURSOR_RING_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    };

    // A press is a sample where the button went down. Frames step past
    // samples — a 13ms trackpad tap falls between two 60fps frames about half
    // the time — so every sample crossed since the last frame is checked, not
    // just the state at this one. A seek or a resume only re-syncs.
    const detectPress = (index: number, time: number) => {
      const continuous =
        lastIndex !== null &&
        index >= lastIndex &&
        time >= lastTime &&
        time - lastTime < CONTINUOUS_PLAYBACK_MS;
      if (continuous) {
        for (let i = lastIndex! + 1; i <= index; i++) {
          const sample = cursorSamples[i];
          if (sample.visible && isButtonDown(sample) && !isButtonDown(cursorSamples[i - 1])) {
            pressedUntil = time + CURSOR_TAP_HOLD_MS;
            ripple();
            break;
          }
        }
      }
      lastIndex = index;
      lastTime = time;
    };

    const updateCursor = () => {
      const snapshot = actorRef.getSnapshot();

      if (!selectIsPlaying(snapshot)) {
        element.style.opacity = "0";
        showPressed(false);
        return;
      }

      const time = snapshot.context.timeline.currentTime;
      const result = getCursorPositionAtTime(cursorSamples, time, cursorSampleIndex);

      if (result) {
        cursorSampleIndex = result.index;
        detectPress(result.index, time);
      }

      const cursorPosition = result ? resolveCursorViewportPosition(result.cursor) : null;

      if (!cursorPosition) {
        element.style.opacity = "0";
        showPressed(false);
      } else {
        const offsetParent = hasParent ? element.offsetParent : null;
        const offsetRect = offsetParent?.getBoundingClientRect();
        const x = offsetRect ? cursorPosition.x - offsetRect.left : cursorPosition.x;
        const y = offsetRect ? cursorPosition.y - offsetRect.top : cursorPosition.y;

        element.style.opacity = "1";
        element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        showPressed(isButtonDown(result!.cursor) || time < pressedUntil);
      }

      animationFrameId = requestAnimationFrame(updateCursor);
    };

    updateCursor();

    return () => {
      cancelAnimationFrame(animationFrameId);
      element.style.opacity = "0";
      glyph.style.transform = "";
    };
  }, [actorRef, cursorSamples, hasParent, isCursorSuppressed, isPlaying]);

  if (!isPlaying || isCursorSuppressed || cursorSamples.length === 0) {
    return null;
  }

  return (
    <div
      ref={cursorRef}
      aria-hidden="true"
      style={{
        position: hasParent ? "absolute" : "fixed",
        left: -7,
        top: -5,
        width: 24,
        height: 24,
        pointerEvents: "none",
        zIndex: 9999,
        opacity: 0,
        transform: "translate3d(-9999px, -9999px, 0)",
        willChange: "transform, opacity",
        // No paint containment: it would clip the press ring to the 24px box.
        contain: "layout style",
      }}
    >
      <div
        ref={ringRef}
        style={{
          position: "absolute",
          left: CURSOR_HOTSPOT.x - CURSOR_RING_RADIUS,
          top: CURSOR_HOTSPOT.y - CURSOR_RING_RADIUS,
          width: CURSOR_RING_RADIUS * 2,
          height: CURSOR_RING_RADIUS * 2,
          borderRadius: "50%",
          border: "2px solid rgba(100, 163, 255, 0.9)",
          opacity: 0,
        }}
      />
      <div
        ref={glyphRef}
        style={{
          width: 24,
          height: 24,
          transformOrigin: `${CURSOR_HOTSPOT.x}px ${CURSOR_HOTSPOT.y}px`,
        }}
      >
        <IconCursor width={24} height={24} />
      </div>
    </div>
  );
};

export default CursorComponent;
