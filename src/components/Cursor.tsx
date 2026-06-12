import React, { useEffect, useMemo, useRef } from "react";
import { NextEditorActorContext } from "../contexts/NextEditorActorContext";
import { selectIsPlaying, selectRecording } from "../core/src/useNextEditor";
import { getCursorPositionAtTime, getCursorReplaySamples } from "../core/src/utils/cursorReplay";
import IconCursor from "./icon/IconCursor";

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
  const cursorSamples = useMemo(
    () => (recording ? getCursorReplaySamples(recording) : []),
    [recording],
  );

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

      if (!result?.cursor.visible) {
        element.style.opacity = "0";
      } else {
        element.style.opacity = "1";
        element.style.transform = `translate3d(${result.cursor.x}px, ${result.cursor.y}px, 0)`;
      }

      animationFrameId = requestAnimationFrame(updateCursor);
    };

    updateCursor();

    return () => {
      cancelAnimationFrame(animationFrameId);
      element.style.opacity = "0";
    };
  }, [actorRef, cursorSamples, isPlaying]);

  if (!isPlaying || cursorSamples.length === 0) {
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
