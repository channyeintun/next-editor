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

    const updateCursor = () => {
      const snapshot = actorRef.getSnapshot();

      if (!selectIsPlaying(snapshot)) {
        element.style.opacity = "0";
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
      } else {
        const offsetParent = hasParent ? element.offsetParent : null;
        const offsetRect = offsetParent?.getBoundingClientRect();
        const x = offsetRect ? cursorPosition.x - offsetRect.left : cursorPosition.x;
        const y = offsetRect ? cursorPosition.y - offsetRect.top : cursorPosition.y;

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
