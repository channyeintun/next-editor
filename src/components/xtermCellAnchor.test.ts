import type { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vite-plus/test";
import { createXtermCellAnchor } from "./xtermCellAnchor";

// A console showing `rows` buffer rows (true = wrapped continuation), with
// `screenRows` of them on screen, scrolled to the bottom the way a console
// follows its output; 8px × 20px cells starting at (100, 50).
function fakeConsole(wrapped: boolean[], screenRows: number, cols = 40) {
  const container = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  container.append(screen);
  screen.getBoundingClientRect = () =>
    ({ left: 100, top: 50, width: cols * 8, height: screenRows * 20 }) as DOMRect;
  const buffer = {
    rows: wrapped,
    get length() {
      return this.rows.length;
    },
    viewportY: Math.max(0, wrapped.length - screenRows),
    getLine(y: number) {
      return y < this.rows.length ? { isWrapped: this.rows[y] } : undefined;
    },
  };
  const listeners = { write: [] as Array<() => void>, resize: [] as Array<() => void> };
  const listen = (list: Array<() => void>) => (listener: () => void) => {
    list.push(listener);
    return { dispose: () => list.splice(list.indexOf(listener), 1) };
  };
  const terminal = {
    cols,
    rows: screenRows,
    buffer: { active: buffer },
    onWriteParsed: listen(listeners.write),
    onResize: listen(listeners.resize),
  } as unknown as Terminal;
  return { anchor: createXtermCellAnchor(container, terminal), buffer, listeners };
}

function console_(lines: string[], rows: number, cols = 40) {
  return fakeConsole(
    lines.map(() => false),
    rows,
    cols,
  ).anchor;
}

// The written-line walk xtermCellAnchor did inline before it shared core's
// terminalLines: count unwrapped rows from row 0.
function inlineLineOf(wrapped: boolean[], row: number) {
  let line = -1;
  let firstRow = 0;
  for (let y = 0; y <= row; y++) {
    if (!wrapped[y]) {
      line += 1;
      firstRow = y;
    }
  }
  return { line, firstRow };
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

  it("numbers wrapped lines exactly as the inline row walk did", () => {
    const wrapped = [false, true, true, false, false, true, false, true, true, true, false];
    const { anchor } = fakeConsole(wrapped, wrapped.length);
    for (let row = 0; row < wrapped.length; row++) {
      const { line, firstRow } = inlineLineOf(wrapped, row);
      const cell = anchor.toCell(100 + 3.5 * 8, 50 + (row + 0.5) * 20);
      expect(cell).toEqual({ line, offset: (row - firstRow) * 40 + 3, dx: 0.5, dy: 0.5 });
      expect(anchor.toClient(cell!)).toEqual({ x: 100 + 3.5 * 8, y: 50 + (row + 0.5) * 20 });
    }
  });

  it("reads the buffer again after a write or a resize, and stops listening on dispose", () => {
    const { anchor, buffer, listeners } = fakeConsole([false, false, false], 3);
    const cell = { line: 1, offset: 0, dx: 0.5, dy: 0.5 };
    expect(anchor.toClient(cell)).toEqual({ x: 104, y: 80 });

    // The first line now wraps onto the second row, at the same buffer length:
    // line 1 starts a row lower.
    buffer.rows = [false, true, false];
    expect(anchor.toClient(cell)).toEqual({ x: 104, y: 80 });
    listeners.write.forEach((listener) => listener());
    expect(anchor.toClient(cell)).toEqual({ x: 104, y: 100 });

    buffer.rows = [false, false, false];
    listeners.resize.forEach((listener) => listener());
    expect(anchor.toClient(cell)).toEqual({ x: 104, y: 80 });

    anchor.dispose();
    expect(listeners.write).toEqual([]);
    expect(listeners.resize).toEqual([]);
  });

  it("reads the buffer again when its length changes without an event", () => {
    // clear() drops scrollback without a parsed write.
    const { anchor, buffer } = fakeConsole([false, true, false], 3);
    expect(anchor.toClient({ line: 1, offset: 0, dx: 0, dy: 0 })).toEqual({ x: 100, y: 90 });
    buffer.rows = [false, false];
    buffer.viewportY = 0;
    expect(anchor.toClient({ line: 1, offset: 0, dx: 0, dy: 0 })).toEqual({ x: 100, y: 70 });
  });
});
