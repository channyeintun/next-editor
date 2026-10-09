import type { IBuffer, Terminal } from "@xterm/xterm";
import type { CursorCellAnchor } from "../core/src/types";
import type { CursorCellAnchorProvider } from "../core/src/utils/cursorCellAnchors";
import {
  firstRowOfWrittenLine,
  writtenLineAtRow,
  writtenLineStarts,
} from "../core/src/utils/terminalLines";

const roundFraction = (value: number) => Math.round(value * 100) / 100;

/**
 * The cell anchor for one xterm terminal (see cursorCellAnchors): a client
 * point becomes "written line N, character K" from the live buffer, and back.
 * The grid is the `.xterm-screen` box split into `cols` × `rows` cells — the
 * same box xterm lays its rows out in, inside the container's padding.
 *
 * Replay asks for a point every frame the pointer is over the console, so the
 * rows that start each written line are kept until a write, a resize (which
 * rewraps) or a different buffer could have moved them.
 */
export function createXtermCellAnchor(
  container: Element,
  terminal: Terminal,
): CursorCellAnchorProvider & { dispose(): void } {
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

  let starts: number[] | null = null;
  let startsBuffer: IBuffer | null = null;
  let startsLength = -1;
  const startsOf = (buffer: IBuffer) => {
    if (!starts || startsBuffer !== buffer || startsLength !== buffer.length) {
      starts = writtenLineStarts(buffer);
      startsBuffer = buffer;
      startsLength = buffer.length;
    }
    return starts;
  };
  const forgetStarts = () => {
    starts = null;
  };
  const writeDisposable = terminal.onWriteParsed(forgetStarts);
  const resizeDisposable = terminal.onResize(forgetStarts);

  return {
    toCell(clientX, clientY) {
      const g = grid();
      const colF = (clientX - g.left) / g.cellWidth;
      const rowF = (clientY - g.top) / g.cellHeight;
      if (!g.ok || colF < 0 || rowF < 0 || colF >= g.cols || rowF >= g.rows) return null;
      const buffer = terminal.buffer.active;
      const row = buffer.viewportY + Math.floor(rowF);
      if (row >= buffer.length) return null;
      const written = writtenLineAtRow(startsOf(buffer), row);
      if (!written) return null;
      const col = Math.floor(colF);
      return {
        line: written.line,
        offset: (row - written.firstRow) * g.cols + col,
        dx: roundFraction(colF - col),
        dy: roundFraction(rowF - Math.floor(rowF)),
      };
    },
    toClient(cell: CursorCellAnchor) {
      const g = grid();
      if (!g.ok) return null;
      const buffer = terminal.buffer.active;
      const firstRow = firstRowOfWrittenLine(startsOf(buffer), cell.line);
      if (firstRow === null) return null;
      const viewRow = firstRow + Math.floor(cell.offset / g.cols) - buffer.viewportY;
      if (viewRow < 0 || viewRow >= g.rows) return null;
      return {
        x: g.left + ((cell.offset % g.cols) + cell.dx) * g.cellWidth,
        y: g.top + (viewRow + cell.dy) * g.cellHeight,
      };
    },
    dispose() {
      writeDisposable.dispose();
      resizeDisposable.dispose();
      starts = null;
      startsBuffer = null;
    },
  };
}
