import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { readStoredPreference, writeStoredPreference } from "../../stores/preferenceStorage";
import { clampPosition, getDefaultPosition, type OverlayPosition } from "./overlayGeometry";

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
 * Where the overlay sits, dragged by the pointer and kept inside the viewport as the window
 * resizes. It starts from the stored position, clamped to the window it mounts in (or the
 * default spot above the player bar's right end), and every position it takes is stored,
 * the first one included.
 */
export function useDraggableOverlayPosition() {
  const dragOffsetRef = useRef<OverlayPosition>({ x: 0, y: 0 });
  const [position, setPosition] = useState(readStoredPosition);

  useEffect(() => {
    const handleResize = () => {
      setPosition((current) => clampPosition(current));
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    writeStoredPreference(POSITION_KEY, JSON.stringify(position));
  }, [position]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
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

  return { position, handlePointerDown, handlePointerMove };
}
