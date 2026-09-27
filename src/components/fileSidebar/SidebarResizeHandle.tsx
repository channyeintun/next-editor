import { useEffect, useRef, useState } from "react";
import { dispatchRecordedCursorVisibility } from "../../utils/recordedCursorVisibility";
import {
  DEFAULT_FILE_SIDEBAR_WIDTH,
  FILE_SIDEBAR_KEYBOARD_LARGE_STEP,
  FILE_SIDEBAR_KEYBOARD_STEP,
  getClampedFileSidebarWidth,
  getFileSidebarMaxWidth,
  MIN_FILE_SIDEBAR_WIDTH,
} from "../../utils/sidebarLayout";

interface SidebarResizeHandleProps {
  width: number;
  onWidthChange: (width: number) => void;
}

/**
 * The file sidebar's width: the drag handle on its right edge (pointer drag,
 * arrow keys, Home and End), and keeping the width in bounds as the window
 * resizes.
 */
export default function SidebarResizeHandle({ width, onWidthChange }: SidebarResizeHandleProps) {
  const resizeStartRef = useRef({
    x: 0,
    y: 0,
    width: DEFAULT_FILE_SIDEBAR_WIDTH,
  });
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    const handleWindowResize = () => {
      onWidthChange(getClampedFileSidebarWidth(width, window.innerWidth));
    };

    window.addEventListener("resize", handleWindowResize);
    return () => {
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [onWidthChange, width]);

  useEffect(() => {
    if (!isResizing) {
      return;
    }

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (event: PointerEvent) => {
      const dragOffset = event.clientX - resizeStartRef.current.x;
      const nextWidth = resizeStartRef.current.width + dragOffset;
      onWidthChange(getClampedFileSidebarWidth(nextWidth, window.innerWidth));
      dispatchRecordedCursorVisibility({
        x: event.clientX,
        y: event.clientY,
        visible: false,
      });
    };

    const stopResizing = (event: PointerEvent) => {
      dispatchRecordedCursorVisibility({
        x: event.clientX,
        y: event.clientY,
        visible: true,
      });
      setIsResizing(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
    };
  }, [isResizing, onWidthChange]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      width,
    };
    dispatchRecordedCursorVisibility({
      x: event.clientX,
      y: event.clientY,
      visible: false,
    });
    setIsResizing(true);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number;

    switch (event.key) {
      case "ArrowLeft":
        nextWidth =
          width - (event.shiftKey ? FILE_SIDEBAR_KEYBOARD_LARGE_STEP : FILE_SIDEBAR_KEYBOARD_STEP);
        break;
      case "ArrowRight":
        nextWidth =
          width + (event.shiftKey ? FILE_SIDEBAR_KEYBOARD_LARGE_STEP : FILE_SIDEBAR_KEYBOARD_STEP);
        break;
      case "Home":
        nextWidth = MIN_FILE_SIDEBAR_WIDTH;
        break;
      case "End":
        nextWidth = getFileSidebarMaxWidth(window.innerWidth);
        break;
      default:
        return;
    }

    event.preventDefault();
    onWidthChange(getClampedFileSidebarWidth(nextWidth, window.innerWidth));
  };

  return (
    <>
      {isResizing ? (
        <div aria-hidden="true" className="fixed inset-0 z-40 cursor-col-resize" />
      ) : null}
      <div
        role="separator"
        aria-label="Resize file sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_FILE_SIDEBAR_WIDTH}
        aria-valuemax={getFileSidebarMaxWidth(
          typeof window === "undefined" ? undefined : window.innerWidth,
        )}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onKeyDown={handleKeyDown}
        className={`absolute inset-y-0 -right-1 z-50 w-2 cursor-col-resize touch-none outline-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors hover:before:bg-sky-400 focus-visible:before:bg-sky-400 ${
          isResizing ? "before:bg-sky-400" : ""
        }`}
      />
    </>
  );
}
