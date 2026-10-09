import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import { clampPreviewDockWidth } from "../../contexts/PreviewPanelContext";
import type { PreviewPanelMode, PreviewSize } from "../../types/slides";
import type { WorkspaceWidthDeltas } from "../../types/workspace";
import {
  clampCustomPreviewSize,
  getCustomPreviewSizeFromResize,
  isCustomPreviewSize,
} from "./previewSizeUtils";

// The preview panel's resize UX: dragging the floating panel's corner or the
// docked panel's edge, the window menu's Larger/Smaller steps, and keeping a
// custom floating size inside the viewport. The controller wires it; resizes are
// recorded through the controller's preview and workspace events.

/** How far one Larger/Smaller menu step resizes the preview, in CSS pixels. */
const PREVIEW_RESIZE_STEP_PX = 48;

/**
 * Follows the pointer that pressed a resize handle until it is released or
 * cancelled (a system gesture, palm rejection). The handle captures the pointer,
 * so moves keep arriving over the preview iframe and outside the window, for
 * mouse, touch and pen alike. Returns a function that stops following without
 * ending the drag, for when the controller unmounts mid-drag.
 */
function followPointerDrag(
  event: ReactPointerEvent<HTMLElement>,
  onMove: (moveEvent: PointerEvent) => void,
  onEnd: () => void,
): () => void {
  const { pointerId } = event;
  event.currentTarget.setPointerCapture(pointerId);

  const handleMove = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId === pointerId) {
      onMove(moveEvent);
    }
  };
  const handleEnd = (endEvent: PointerEvent) => {
    if (endEvent.pointerId !== pointerId) {
      return;
    }
    stopFollowing();
    onEnd();
  };
  const stopFollowing = () => {
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleEnd);
    window.removeEventListener("pointercancel", handleEnd);
  };

  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleEnd);
  window.addEventListener("pointercancel", handleEnd);
  return stopFollowing;
}

interface UsePreviewResizeOptions {
  /** The panel root, measured when a resize starts. */
  containerRef: RefObject<HTMLDivElement | null>;
  panelMode: PreviewPanelMode;
  dockWidth: number;
  setDockWidth: (width: number) => void;
  setSize: Dispatch<SetStateAction<PreviewSize>>;
  isRecordingRef: RefObject<boolean>;
  handleWorkspaceEvent: (event?: WorkspaceWidthDeltas) => void;
  /** Records a preview event; a size-less one records the size the panel has now. */
  emitPreviewEvent: (eventType: "preview_resize", options?: { newSize?: PreviewSize }) => void;
}

export interface PreviewResize {
  /** True while a resize drag is in progress. */
  isResizing: boolean;
  handleResizeStart: (event: ReactPointerEvent<HTMLElement>) => void;
  handleDockResizeStart: (event: ReactPointerEvent<HTMLElement>) => void;
  /** Click/keyboard alternative to dragging a resize handle: one step bigger or smaller. */
  handleResizeStep: (direction: 1 | -1) => void;
}

export function usePreviewResize({
  containerRef,
  panelMode,
  dockWidth,
  setDockWidth,
  setSize,
  isRecordingRef,
  handleWorkspaceEvent,
  emitPreviewEvent,
}: UsePreviewResizeOptions): PreviewResize {
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    const clampCurrentCustomSize = () => {
      setSize((currentSize) => {
        if (!isCustomPreviewSize(currentSize)) {
          return currentSize;
        }

        const nextSize = clampCustomPreviewSize(currentSize, {
          width: window.innerWidth,
          height: window.innerHeight,
        });

        if (nextSize.width === currentSize.width && nextSize.height === currentSize.height) {
          return currentSize;
        }

        return nextSize;
      });
    };

    clampCurrentCustomSize();
    window.addEventListener("resize", clampCurrentCustomSize);

    return () => {
      window.removeEventListener("resize", clampCurrentCustomSize);
    };
  }, []);

  // Stops the window listeners of a resize drag still in progress; the unmount
  // cleanup below calls it so a drag cannot outlive the preview.
  const stopFollowingDragRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopFollowingDragRef.current?.(), []);

  const handleResizeStart = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setIsResizing(true);

    const startPointer = { x: event.clientX, y: event.clientY };
    const startSize = { width: rect.width, height: rect.height };

    setSize(
      clampCustomPreviewSize(startSize, { width: window.innerWidth, height: window.innerHeight }),
    );

    let resizeRaf: number | null = null;
    const onMove = (moveEvent: PointerEvent) => {
      const newSize = getCustomPreviewSizeFromResize({
        startSize,
        startPointer,
        currentPointer: { x: moveEvent.clientX, y: moveEvent.clientY },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
      setSize(newSize);

      if (resizeRaf) {
        cancelAnimationFrame(resizeRaf);
      }
      resizeRaf = requestAnimationFrame(() => {
        emitPreviewEvent("preview_resize", { newSize });
      });
    };

    const onEnd = () => {
      stopFollowingDragRef.current = null;
      setIsResizing(false);
      if (resizeRaf) {
        cancelAnimationFrame(resizeRaf);
      }
      emitPreviewEvent("preview_resize");
    };

    stopFollowingDragRef.current?.();
    stopFollowingDragRef.current = followPointerDrag(event, onMove, onEnd);
  };

  const handleDockResizeStart = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setIsResizing(true);

    const startX = event.clientX;
    const startWidth = rect.width;
    let lastWidth = startWidth;

    const onMove = (moveEvent: PointerEvent) => {
      lastWidth = clampPreviewDockWidth(startWidth + startX - moveEvent.clientX, window.innerWidth);
      setDockWidth(lastWidth);
    };

    const onEnd = () => {
      stopFollowingDragRef.current = null;
      setIsResizing(false);

      // Record the net resize as an offset (not an absolute width) so playback
      // applies the same delta to whatever dock width the viewer has.
      const previewDockWidthDelta = Math.round(lastWidth - startWidth);
      if (isRecordingRef.current && previewDockWidthDelta !== 0) {
        handleWorkspaceEvent({ previewDockWidthDelta });
      }
    };

    stopFollowingDragRef.current?.();
    stopFollowingDragRef.current = followPointerDrag(event, onMove, onEnd);
  };

  // The non-drag way to resize (WCAG 2.1.1 and 2.5.7): the window menu's
  // Larger/Smaller items step the panel by a fixed amount. Each step is
  // recorded the same way a finished drag is, so playback is unchanged.
  const handleResizeStep = (direction: 1 | -1) => {
    const step = PREVIEW_RESIZE_STEP_PX * direction;

    if (panelMode === "docked") {
      const nextWidth = clampPreviewDockWidth(dockWidth + step, window.innerWidth);
      const previewDockWidthDelta = Math.round(nextWidth - dockWidth);
      if (previewDockWidthDelta === 0) {
        return;
      }

      setDockWidth(nextWidth);
      if (isRecordingRef.current) {
        handleWorkspaceEvent({ previewDockWidthDelta });
      }
      return;
    }

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const newSize = clampCustomPreviewSize(
      { width: rect.width + step, height: rect.height + step },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setSize(newSize);
    // One event carrying the new size. The drag path's trailing size-less
    // event reads sizeRef, which still holds the old size until this render
    // commits, so emitting one here would record the panel shrinking back.
    emitPreviewEvent("preview_resize", { newSize });
  };

  return { isResizing, handleResizeStart, handleDockResizeStart, handleResizeStep };
}
