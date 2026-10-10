import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { readStoredPreference, writeStoredPreference } from "../../stores/preferenceStorage";
import {
  clampPosition,
  getDefaultPosition,
  nextCornerPosition,
  type OverlayPosition,
} from "./overlayGeometry";

const POSITION_KEY = "next-editor-camera-overlay-position";

function readStoredPosition(): OverlayPosition {
  const rawPosition = readStoredPreference(POSITION_KEY);
  if (!rawPosition) return getDefaultPosition();

  try {
    const parsed = JSON.parse(rawPosition) as Partial<OverlayPosition>;
    if (typeof parsed.x === "number" && typeof parsed.y === "number") {
      return clampPosition({ x: parsed.x, y: parsed.y });
    }
  } catch {
    return getDefaultPosition();
  }

  return getDefaultPosition();
}

/**
 * Where the overlay sits, dragged by the pointer (or stepped through the corners by
 * `moveToNextCorner`) and kept inside the viewport as the window resizes. It starts from the
 * stored position, clamped to the window it mounts in (or the default spot above the player
 * bar's right end). The position is stored when a drag ends, and after each corner step or
 * window resize, the first position included.
 */
export function useDraggableOverlayPosition() {
  const dragOffsetRef = useRef<OverlayPosition>({ x: 0, y: 0 });
  const [position, setPosition] = useState(readStoredPosition);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    // The same position when the clamp changes nothing, so a resize that leaves the overlay
    // where it is neither re-renders nor stores it again.
    const handleResize = () => {
      setPosition((current) => {
        const next = clampPosition(current);
        return next.x === current.x && next.y === current.y ? current : next;
      });
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  // A drag stores where it ends, not every pointermove on the way (each one a synchronous
  // localStorage write and a storage event in every other tab).
  useEffect(() => {
    if (isDragging) return;
    writeStoredPreference(POSITION_KEY, JSON.stringify(position));
  }, [position, isDragging]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
    dragOffsetRef.current = {
      x: event.clientX - position.x,
      y: event.clientY - position.y,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;

    setPosition(
      clampPosition({
        x: event.clientX - dragOffsetRef.current.x,
        y: event.clientY - dragOffsetRef.current.y,
      }),
    );
  };

  // The drag ends when the pointer is released or loses its capture (a cancelled touch).
  const handleDragEnd = () => {
    setIsDragging(false);
  };

  // The single-pointer and keyboard alternative to dragging: step to the next corner clockwise.
  const moveToNextCorner = () => {
    setPosition((current) => nextCornerPosition(current));
  };

  return { position, handlePointerDown, handlePointerMove, handleDragEnd, moveToNextCorner };
}
