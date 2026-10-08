import type { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vite-plus/test";
import { createXtermCellAnchor } from "./xtermCellAnchor";

// A console showing `lines` with `rows` rows on screen, scrolled to the bottom
// the way a console follows its output; 8px × 20px cells starting at (100, 50).
function console_(lines: string[], rows: number, cols = 40) {
  const container = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  container.append(screen);
  screen.getBoundingClientRect = () =>
    ({ left: 100, top: 50, width: cols * 8, height: rows * 20 }) as DOMRect;
  const buffer = {
    length: lines.length,
    viewportY: Math.max(0, lines.length - rows),
    getLine: (y: number) => (y < lines.length ? { isWrapped: false } : undefined),
  };
  const terminal = { cols, rows, buffer: { active: buffer } } as unknown as Terminal;
  return createXtermCellAnchor(container, terminal);
}

const output = [
  "[go-run] go run main.go",
  "0 apple",
  "1 banana",
  "2 mango",
  "total: 3",
  "[go-run] Program exited",
];

describe("createXtermCellAnchor", () => {
  it("turns a point into the written line and character under it, and back", () => {
    const anchor = console_(output, 6);
    // Just past the end of "1 banana" (8 characters), on its row.
    const cell = anchor.toCell(100 + 8.6 * 8, 50 + 2.5 * 20);

    expect(cell).toEqual({ line: 2, offset: 8, dx: 0.6, dy: 0.5 });
    expect(anchor.toClient(cell!)).toEqual({ x: 100 + 8.6 * 8, y: 50 + 2.5 * 20 });
  });

  it("finds the same line on a console that fits a different number of rows", () => {
    // Recorded on a console of 4 rows: it had scrolled two lines.
    const recorded = console_(output, 4);
    const cell = recorded.toCell(100 + 8.6 * 8, 50 + 0.5 * 20);
    expect(cell?.line).toBe(2);

    // Replayed on 7 rows: nothing scrolled, so "1 banana" is the third row
    // down, not the first — a pixel offset would land on the header.
    const replayed = console_(output, 7);
    expect(replayed.toClient(cell!)).toEqual({ x: 100 + 8.6 * 8, y: 50 + 2.5 * 20 });
  });

  it("has no point for a line scrolled out of view, and no cell outside the grid", () => {
    const anchor = console_(output, 2);
    expect(anchor.toClient({ line: 1, offset: 3, dx: 0.5, dy: 0.5 })).toBeNull();
    expect(anchor.toCell(90, 60)).toBeNull();
    expect(anchor.toCell(100 + 41 * 8, 60)).toBeNull();
  });
});
