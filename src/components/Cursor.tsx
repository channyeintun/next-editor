import React, { useEffect, useMemo, useRef, useState } from "react";
import { NextEditorActorContext } from "../contexts/NextEditorActorContext";
import { selectIsPlaying, selectRecording } from "../core/src/useNextEditor";
import { resolveCursorViewportPosition } from "../core/src/utils/cursorCoordinates";
import { getCursorPositionAtTime, getCursorReplaySamples } from "../core/src/utils/cursorReplay";
import IconCursor from "./icon/IconCursor";
import {
  isRecordedCursorVisibilityDetail,
  RECORDED_CURSOR_VISIBILITY_EVENT,
} from "../utils/recordedCursorVisibility";

const CURSOR_SNAP_DISTANCE = 2;
const CURSOR_JUMP_DISTANCE = 50;
const CURSOR_INITIAL_EASE = 0.15;
const CURSOR_MAX_EASE = 0.6;
const CURSOR_EASE_STEP = 0.015;

/**
 * CursorComponent - Displays a fake cursor overlay during playback.
 */
const CursorComponent: React.FC<{
  hasParent?: boolean;
}> = ({ hasParent }) => {
  const actorRef = NextEditorActorContext.useActorRef();
  const isPlaying = NextEditorActorContext.useSelector(selectIsPlaying);
  const recording = NextEditorActorContext.useSelector(selectRecording);
  const cursorRef = useRef<HTMLDivElement>(null);
  const [isCursorSuppressed, setIsCursorSuppressed] = useState(false);
  const cursorSamples = useMemo(
    () => (recording ? getCursorReplaySamples(recording) : []),
    [recording],
  );

  useEffect(() => {
    const handleRecordedCursorVisibility = (event: Event) => {
      if (!(event instanceof CustomEvent) || !isRecordedCursorVisibilityDetail(event.detail)) {
        return;
      }

      setIsCursorSuppressed(!event.detail.visible);
    };

    window.addEventListener(RECORDED_CURSOR_VISIBILITY_EVENT, handleRecordedCursorVisibility);
    return () => {
      window.removeEventListener(RECORDED_CURSOR_VISIBILITY_EVENT, handleRecordedCursorVisibility);
    };
  }, []);

  useEffect(() => {
    const element = cursorRef.current;
    if (!isPlaying || !element || cursorSamples.length === 0) {
      return;
    }

    let animationFrameId = 0;
    let cursorSampleIndex = 0;
    let x = Number.NaN;
    let y = Number.NaN;
    let targetX = Number.NaN;
    let targetY = Number.NaN;
    let sx = 1;
    let sy = 1;

    const updateCursor = () => {
      const snapshot = actorRef.getSnapshot();

      if (!selectIsPlaying(snapshot)) {
        element.style.opacity = "0";
        x = Number.NaN;
        y = Number.NaN;
        return;
      }

      const result = getCursorPositionAtTime(
        cursorSamples,
        snapshot.context.timeline.currentTime,
        cursorSampleIndex,
      );

      if (result) {
        cursorSampleIndex = result.index;
      }

      const cursorPosition = result ? resolveCursorViewportPosition(result.cursor) : null;

      if (!cursorPosition) {
        element.style.opacity = "0";
        x = Number.NaN;
        y = Number.NaN;
      } else {
        const offsetParent = hasParent ? element.offsetParent : null;
        const offsetRect = offsetParent?.getBoundingClientRect();
        const nextTargetX = offsetRect ? cursorPosition.x - offsetRect.left : cursorPosition.x;
        const nextTargetY = offsetRect ? cursorPosition.y - offsetRect.top : cursorPosition.y;

        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          x = nextTargetX;
          y = nextTargetY;
          sx = 1;
          sy = 1;
        } else if (
          Math.abs(nextTargetX - x) > CURSOR_JUMP_DISTANCE &&
          Math.abs(nextTargetY - y) > CURSOR_JUMP_DISTANCE
        ) {
          x = nextTargetX;
          y = nextTargetY;
          sx = CURSOR_INITIAL_EASE;
          sy = CURSOR_INITIAL_EASE;
        }

        targetX = nextTargetX;
        targetY = nextTargetY;

        const dx = targetX - x;
        const dy = targetY - y;
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);

        if (
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          (absX < CURSOR_SNAP_DISTANCE && absY < CURSOR_SNAP_DISTANCE)
        ) {
          x = targetX;
          y = targetY;
          sx = 1;
          sy = 1;
        } else {
          x += dx * sx;
          y += dy * sy;

          if (sx < CURSOR_MAX_EASE) sx += CURSOR_EASE_STEP;
          if (sy < CURSOR_MAX_EASE) sy += CURSOR_EASE_STEP;
        }

        element.style.opacity = "1";
        element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      }

      animationFrameId = requestAnimationFrame(updateCursor);
    };

    updateCursor();

    return () => {
      cancelAnimationFrame(animationFrameId);
      element.style.opacity = "0";
    };
  }, [actorRef, cursorSamples, hasParent, isPlaying]);

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
        contain: "layout paint style",
      }}
    >
      <IconCursor width={24} height={24} />
    </div>
  );
};

export default CursorComponent;
