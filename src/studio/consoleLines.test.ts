import { describe, expect, it } from "vite-plus/test";
import {
  consoleLineAimPoint,
  endColumnOf,
  findConsoleLine,
  logicalConsoleLines,
  type ConsoleBuffer,
  type ConsoleBufferLine,
} from "./consoleLines";

/** A fake xterm row: one cell per character, padded with blanks to `cols`. */
function row(text: string, cols = 20, isWrapped = false): ConsoleBufferLine {
  const cells = [...text.padEnd(cols, " ")].map((chars) => ({
    getChars: () => (chars === " " ? "" : chars),
    getWidth: () => 1,
  }));
  return {
    isWrapped,
    length: cols,
    translateToString: (trimRight) => (trimRight ? text.trimEnd() : text.padEnd(cols)),
    getCell: (x) => cells[x],
  };
}

function bufferOf(rows: ConsoleBufferLine[], viewportY = 0): ConsoleBuffer {
  return { length: rows.length, viewportY, getLine: (y) => rows[y] };
}

describe("logicalConsoleLines", () => {
  it("joins a wrapped line's rows back into the line that was written", () => {
    const buffer = bufferOf([row("[go-run] go run main"), row(".go", 20, true), row("0 apple")]);

    expect(logicalConsoleLines(buffer)).toEqual([
      { text: "[go-run] go run main.go", firstRow: 0, lastRow: 1 },
      { text: "0 apple", firstRow: 2, lastRow: 2 },
    ]);
  });
});

describe("endColumnOf", () => {
  it("ends just past the last visible character, ignoring trailing blanks", () => {
    expect(endColumnOf(row("0 apple"))).toBe(7);
    expect(endColumnOf(row(""))).toBe(0);
  });

  it("counts a wide character's two cells", () => {
    const wide: ConsoleBufferLine = {
      isWrapped: false,
      length: 4,
      translateToString: () => "a漢",
      getCell: (x) =>
        [
          { getChars: () => "a", getWidth: () => 1 },
          { getChars: () => "漢", getWidth: () => 2 },
          { getChars: () => "", getWidth: () => 0 },
          { getChars: () => "", getWidth: () => 1 },
        ][x],
    };
    expect(endColumnOf(wide)).toBe(3);
  });
});

describe("findConsoleLine", () => {
  const twoRuns = [
    row("[go-run] go run main.go"),
    row("0 apple"),
    row("[go-run] Program exited"),
    row("[go-run] go run main.go"),
    row("0 apple"),
    row("1 banana"),
    row("[go-run] Program exited"),
  ];

  it("reads the latest run's output, not an earlier run's identical line", () => {
    const lookup = findConsoleLine({
      buffer: bufferOf(twoRuns),
      rows: 10,
      text: "apple",
      occurrence: 1,
      runHeader: "[go-run] go run main.go",
    });

    expect(lookup).toMatchObject({ status: "visible", viewportRow: 4, endColumn: 7 });
  });

  it("counts occurrences within that run", () => {
    expect(
      findConsoleLine({
        buffer: bufferOf(twoRuns),
        rows: 10,
        text: "a",
        occurrence: 2,
        runHeader: "[go-run] go run main.go",
      }),
    ).toMatchObject({ status: "visible", line: { text: "1 banana" } });
  });

  it("reads the whole console when no run printed a header", () => {
    expect(
      findConsoleLine({ buffer: bufferOf(twoRuns), rows: 10, text: "apple", occurrence: 1 }),
    ).toMatchObject({ status: "visible", viewportRow: 1 });
  });

  it("reports a line scrolled out of view, and one not printed (yet)", () => {
    const buffer = bufferOf(twoRuns, 5);
    expect(
      findConsoleLine({
        buffer,
        rows: 2,
        text: "apple",
        occurrence: 1,
        runHeader: "[go-run] go run main.go",
      }).status,
    ).toBe("offscreen");
    expect(findConsoleLine({ buffer, rows: 2, text: "mango", occurrence: 1 }).status).toBe(
      "missing",
    );
  });

  it("points at the end of a wrapped line, on its last row", () => {
    const buffer = bufferOf([row("a long line that wra"), row("ps here", 20, true)]);
    expect(findConsoleLine({ buffer, rows: 5, text: "long", occurrence: 1 })).toMatchObject({
      status: "visible",
      viewportRow: 1,
      endColumn: 7,
    });
  });
});

describe("consoleLineAimPoint", () => {
  it("rests just past the line's last character, centred on its row", () => {
    const lookup = findConsoleLine({
      buffer: bufferOf([row("0 apple"), row("1 banana")]),
      rows: 10,
      text: "banana",
      occurrence: 1,
    });
    if (lookup.status !== "visible") throw new Error("line not found");

    // 20 columns over 160px = 8px cells; 10 rows over 200px = 20px rows.
    const point = consoleLineAimPoint(
      lookup,
      { left: 100, top: 50, width: 160, height: 200 },
      { cols: 20, rows: 10 },
    );

    expect(point.x).toBeCloseTo(100 + 8.6 * 8);
    expect(point.y).toBe(50 + 1.5 * 20);
  });

  it("follows the painted end when the text draws wider than its cells", () => {
    const lookup = findConsoleLine({
      buffer: bufferOf([row("0 apple")]),
      rows: 10,
      text: "apple",
      occurrence: 1,
    });
    if (lookup.status !== "visible") throw new Error("line not found");
    const screen = { left: 0, top: 0, width: 160, height: 200 };

    // Burmese joins several cells into one wider cluster on screen.
    expect(consoleLineAimPoint(lookup, screen, { cols: 20, rows: 10 }, 120).x).toBeCloseTo(
      120 + 0.6 * 8,
    );
    // Painted short of the cell end (or not measured): the cells decide.
    expect(consoleLineAimPoint(lookup, screen, { cols: 20, rows: 10 }, 30).x).toBeCloseTo(7.6 * 8);
    expect(consoleLineAimPoint(lookup, screen, { cols: 20, rows: 10 }, null).x).toBeCloseTo(
      7.6 * 8,
    );
  });

  it("stays inside the console for a line that fills its width", () => {
    const lookup = findConsoleLine({
      buffer: bufferOf([row("x".repeat(20))]),
      rows: 10,
      text: "x",
      occurrence: 1,
    });
    if (lookup.status !== "visible") throw new Error("line not found");

    const point = consoleLineAimPoint(
      lookup,
      { left: 0, top: 0, width: 160, height: 200 },
      { cols: 20, rows: 10 },
    );

    expect(point.x).toBe(158);
  });
});
