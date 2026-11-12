import type { CursorCellAnchor } from "../core/src/types";
import type { CursorCellAnchorProvider } from "../core/src/utils/cursorCellAnchors";

/** The replay target id of the whiteboard's drawing surface. */
export const WHITEBOARD_CANVAS_TARGET_ID = "whiteboard-canvas";

/** How the canvas shows the scene right now: Excalidraw's scroll and zoom. */
export interface WhiteboardCanvasView {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

export interface WhiteboardScenePoint {
  x: number;
  y: number;
}

const roundFraction = (value: number) => Math.round(value * 100) / 100;

/** A scene point as the anchor a cursor sample carries (see CursorCellAnchor). */
export function whiteboardSceneCell(point: WhiteboardScenePoint): CursorCellAnchor {
  const line = Math.floor(point.y);
  const offset = Math.floor(point.x);
  return {
    line,
    offset,
    dx: roundFraction(point.x - offset),
    dy: roundFraction(point.y - line),
  };
}

/**
 * The cell anchor for the whiteboard canvas (see cursorCellAnchors): a client
 * point becomes a point of the scene and back, through the view the canvas has
 * at that moment. A pointer recorded over the board therefore stays on the box
 * or the word it pointed at when the viewer's board is a different size, or
 * when they pan or zoom it while the lesson plays — the same pixel offset would
 * be a different place in the drawing.
 *
 * `getView` returns null until the canvas has mounted; replay then falls back
 * to the pixel offset, which is the same place at the default view.
 */
export function createWhiteboardSceneAnchor(
  surface: Element,
  getView: () => WhiteboardCanvasView | null,
): CursorCellAnchorProvider {
  const measure = () => {
    const view = getView();
    const rect = surface.getBoundingClientRect();
    if (!view || !(view.zoom > 0) || rect.width <= 0 || rect.height <= 0) return null;
    return { view, rect };
  };

  return {
    toCell(clientX, clientY) {
      const measured = measure();
      if (!measured) return null;
      const { view, rect } = measured;
      if (
        clientX < rect.left ||
        clientY < rect.top ||
        clientX > rect.right ||
        clientY > rect.bottom
      ) {
        return null;
      }
      return whiteboardSceneCell({
        x: (clientX - rect.left) / view.zoom - view.scrollX,
        y: (clientY - rect.top) / view.zoom - view.scrollY,
      });
    },
    toClient(cell) {
      const measured = measure();
      if (!measured) return null;
      const { view, rect } = measured;
      const x = rect.left + (cell.offset + cell.dx + view.scrollX) * view.zoom;
      const y = rect.top + (cell.line + cell.dy + view.scrollY) * view.zoom;
      // A viewer who panned the point off their board still sees which way it
      // went: the pointer waits at the nearest edge instead of leaving the board.
      return {
        x: Math.min(rect.right, Math.max(rect.left, x)),
        y: Math.min(rect.bottom, Math.max(rect.top, y)),
      };
    },
  };
}
