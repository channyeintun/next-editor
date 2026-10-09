/**
 * Finding a console line on screen for the studio pointer (`console.point`).
 *
 * The console is an xterm terminal: a long line wraps over several rows, and
 * only `rows` of them are on screen, starting at `viewportY`. Reading the
 * terminal's own buffer — not the rendered DOM, which differs per renderer —
 * gives the exact row and column of a line's last character, which is where
 * the pointer rests: the arrow's tip just past the end of the text, its body
 * hanging down and to the right over empty space, so the line it points at
 * stays readable.
 *
 * The buffer is read through core's structural terminal-line helpers, so tests
 * can hand in a plain fake.
 */

import {
  endColumnOf,
  logicalTerminalLines,
  type LogicalTerminalLine,
  type TerminalBuffer,
} from "../core/src/utils/terminalLines";

/**
 * Console rows a learner is guaranteed to see in the runner dock. Its console
 * (h-72 body, minus the Run/Clear header, the py-6 wrapper and xterm's 12px
 * padding) leaves 154px for rows; at 13px × 1.5 line height a row is 22px at
 * device pixel ratio 1 (7 rows) and 22.5px at 1.25 and above (6 rows). The
 * smaller count is the one every screen shows; change it with that layout.
 */
export const CONSOLE_VISIBLE_ROWS = 6;

/** Narrowest console the studio renders at, for counting how a long line wraps. */
export const CONSOLE_MIN_COLUMNS = 80;

export type ConsoleLineLookup =
  | {
      status: "visible";
      line: LogicalTerminalLine;
      /** Viewport row (0 = top of the console) holding the line's last character. */
      viewportRow: number;
      /** Column just past that last character. */
      endColumn: number;
    }
  | { status: "offscreen"; line: LogicalTerminalLine }
  | { status: "missing" };

/**
 * The `occurrence`-th line containing `text` in the latest run's output —
 * the lines after the last `runHeader` line, when a run has printed one — and
 * whether it is on screen.
 */
export function findConsoleLine({
  buffer,
  rows,
  text,
  occurrence,
  runHeader,
}: {
  buffer: TerminalBuffer;
  rows: number;
  text: string;
  occurrence: number;
  runHeader?: string | null;
}): ConsoleLineLookup {
  const lines = logicalTerminalLines(buffer);
  let start = 0;
  if (runHeader) {
    const header = runHeader.trim();
    for (let index = lines.length - 1; index >= 0; index--) {
      if (lines[index].text.trim() === header) {
        start = index + 1;
        break;
      }
    }
  }

  let seen = 0;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index];
    if (!line.text.includes(text)) continue;
    seen += 1;
    if (seen < occurrence) continue;

    // A line that ends exactly at the wrap leaves its last row blank; the text
    // then ends on the row above.
    let endRow = line.lastRow;
    let endColumn = endColumnOf(buffer.getLine(endRow)!);
    while (endColumn === 0 && endRow > line.firstRow) {
      endRow -= 1;
      endColumn = endColumnOf(buffer.getLine(endRow)!);
    }
    const viewportRow = endRow - buffer.viewportY;
    if (viewportRow < 0 || viewportRow >= rows) {
      return { status: "offscreen", line };
    }
    return { status: "visible", line, viewportRow, endColumn };
  }
  return { status: "missing" };
}

/**
 * Where the pointer's tip rests for a visible line: just past its last
 * character, centred on its row, inside the console's screen box. The cell
 * grid gives the row and a lower bound for x; `paintedRight` — where the row's
 * text actually ends on screen — wins when it is further right, because the
 * DOM renderer draws some scripts wider than their cell count (Burmese spacing
 * marks take a cell each but join one cluster on screen).
 */
export function consoleLineAimPoint(
  lookup: Extract<ConsoleLineLookup, { status: "visible" }>,
  screen: { left: number; top: number; width: number; height: number },
  grid: { cols: number; rows: number },
  paintedRight?: number | null,
): { x: number; y: number } {
  const cellWidth = screen.width / Math.max(1, grid.cols);
  const cellHeight = screen.height / Math.max(1, grid.rows);
  const gap = 0.6 * cellWidth;
  const fromCells = screen.left + lookup.endColumn * cellWidth + gap;
  const x =
    paintedRight != null && Number.isFinite(paintedRight)
      ? Math.max(fromCells, paintedRight + gap)
      : fromCells;
  return {
    x: Math.min(screen.left + screen.width - 2, x),
    y: screen.top + (lookup.viewportRow + 0.5) * cellHeight,
  };
}
