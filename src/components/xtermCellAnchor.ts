import type { Terminal } from "@xterm/xterm";
import type { CursorCellAnchor } from "../core/src/types";
import type { CursorCellAnchorProvider } from "../core/src/utils/cursorCellAnchors";

const roundFraction = (value: number) => Math.round(value * 100) / 100;

/**
 * The cell anchor for one xterm terminal (see cursorCellAnchors): a client
 * point becomes "written line N, character K" from the live buffer, and back.
 * The grid is the `.xterm-screen` box split into `cols` × `rows` cells — the
 * same box xterm lays its rows out in, inside the container's padding.
 */
export function createXtermCellAnchor(
  container: Element,
  terminal: Terminal,
): CursorCellAnchorProvider {
  const grid = () => {
    const screen = (container.querySelector(".xterm-screen") ?? container).getBoundingClientRect();
    const cols = Math.max(1, terminal.cols);
    const rows = Math.max(1, terminal.rows);
    return {
      left: screen.left,
      top: screen.top,
      ok: screen.width > 0 && screen.height > 0,
      cols,
      rows,
      cellWidth: screen.width / cols,
      cellHeight: screen.height / rows,
    };
  };

  return {
    toCell(clientX, clientY) {
      const g = grid();
      const colF = (clientX - g.left) / g.cellWidth;
      const rowF = (clientY - g.top) / g.cellHeight;
      if (!g.ok || colF < 0 || rowF < 0 || colF >= g.cols || rowF >= g.rows) return null;
      const buffer = terminal.buffer.active;
      const row = buffer.viewportY + Math.floor(rowF);
      if (row >= buffer.length) return null;
      // The written line holding this row: count line starts (unwrapped rows).
      let line = -1;
      let firstRow = 0;
      for (let y = 0; y <= row; y++) {
        if (!buffer.getLine(y)?.isWrapped) {
          line += 1;
          firstRow = y;
        }
      }
      if (line < 0) return null;
      const col = Math.floor(colF);
      return {
        line,
        offset: (row - firstRow) * g.cols + col,
        dx: roundFraction(colF - col),
        dy: roundFraction(rowF - Math.floor(rowF)),
      };
    },
    toClient(cell: CursorCellAnchor) {
      const g = grid();
      if (!g.ok) return null;
      const buffer = terminal.buffer.active;
      let line = -1;
      let firstRow = -1;
      for (let y = 0; y < buffer.length; y++) {
        if (!buffer.getLine(y)?.isWrapped) {
          line += 1;
          if (line === cell.line) {
            firstRow = y;
            break;
          }
        }
      }
      if (firstRow < 0) return null;
      const viewRow = firstRow + Math.floor(cell.offset / g.cols) - buffer.viewportY;
      if (viewRow < 0 || viewRow >= g.rows) return null;
      return {
        x: g.left + ((cell.offset % g.cols) + cell.dx) * g.cellWidth,
        y: g.top + (viewRow + cell.dy) * g.cellHeight,
      };
    },
  };
}
