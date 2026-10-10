// Where the file context menu opens: at the pointer, moved back inside the
// viewport with a margin, and never taller than the viewport allows.

interface ContextMenuPlacementInput {
  anchorX: number;
  anchorY: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}

interface ContextMenuPlacement {
  left: number;
  top: number;
  maxHeight: number;
}

const CONTEXT_MENU_VIEWPORT_MARGIN = 8;
export const CONTEXT_MENU_FALLBACK_WIDTH = 224;
export const CONTEXT_MENU_FALLBACK_HEIGHT = 320;

function clampViewportValue(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

export function getViewportClampedContextMenuPlacement({
  anchorX,
  anchorY,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  margin = CONTEXT_MENU_VIEWPORT_MARGIN,
}: ContextMenuPlacementInput): ContextMenuPlacement {
  const availableWidth = Math.max(viewportWidth - margin * 2, 0);
  const availableHeight = Math.max(viewportHeight - margin * 2, 0);
  const renderedWidth = Math.min(Math.max(menuWidth, 0), availableWidth);
  const renderedHeight = Math.min(Math.max(menuHeight, 0), availableHeight);

  return {
    left: clampViewportValue(anchorX, margin, viewportWidth - renderedWidth - margin),
    top: clampViewportValue(anchorY, margin, viewportHeight - renderedHeight - margin),
    maxHeight: availableHeight,
  };
}
