import { describe, expect, it } from "vite-plus/test";
import {
  firstRowOfWrittenLine,
  logicalTerminalLines,
  writtenLineAtRow,
  writtenLineStarts,
  type TerminalBuffer,
  type TerminalBufferLine,
} from "./terminalLines";

function row(text: string, isWrapped = false): TerminalBufferLine {
  return {
    isWrapped,
    length: 20,
    translateToString: (trimRight) => (trimRight ? text.trimEnd() : text.padEnd(20)),
    getCell: () => undefined,
  };
}

function bufferOf(rows: Array<TerminalBufferLine | undefined>): TerminalBuffer {
  return { length: rows.length, viewportY: 0, getLine: (y) => rows[y] };
}

// "[go-run] go run main.go" wrapped over two rows, then two short lines, the
// second of them wrapped too.
const wrapped = bufferOf([
  row("[go-run] go run main"),
  row(".go", true),
  row("0 apple"),
  row("1 banana banana bana"),
  row("na", true),
]);

describe("writtenLineStarts", () => {
  it("starts a line on every row that is not a wrapped continuation", () => {
    expect(writtenLineStarts(wrapped)).toEqual([0, 2, 3]);
  });

  it("starts the first line on the first row even when it is a continuation", () => {
    // Scrollback trimmed the start of a wrapped line away.
    const trimmed = bufferOf([row("na", true), row("0 apple")]);
    expect(writtenLineStarts(trimmed)).toEqual([0, 1]);
  });

  it("skips a row the buffer does not have", () => {
    const holed = bufferOf([row("[go-run] go run main"), undefined, row(".go", true), row("x")]);
    expect(writtenLineStarts(holed)).toEqual([0, 3]);
  });
});

describe("writtenLineAtRow and firstRowOfWrittenLine", () => {
  const starts = writtenLineStarts(wrapped);

  it("finds the written line holding a row and the row it starts on", () => {
    expect(writtenLineAtRow(starts, 0)).toEqual({ line: 0, firstRow: 0 });
    expect(writtenLineAtRow(starts, 1)).toEqual({ line: 0, firstRow: 0 });
    expect(writtenLineAtRow(starts, 2)).toEqual({ line: 1, firstRow: 2 });
    expect(writtenLineAtRow(starts, 4)).toEqual({ line: 2, firstRow: 3 });
    expect(writtenLineAtRow(starts, 99)).toEqual({ line: 2, firstRow: 3 });
  });

  it("has no line above the first start or in an empty buffer", () => {
    expect(writtenLineAtRow([2, 5], 1)).toBeNull();
    expect(writtenLineAtRow([], 0)).toBeNull();
  });

  it("gives each line's first row, and null past the last line", () => {
    expect(starts.map((_, line) => firstRowOfWrittenLine(starts, line))).toEqual([0, 2, 3]);
    expect(firstRowOfWrittenLine(starts, 3)).toBeNull();
    expect(firstRowOfWrittenLine(starts, -1)).toBeNull();
  });
});

describe("logicalTerminalLines", () => {
  it("joins a wrapped line's rows back into the line that was written", () => {
    expect(logicalTerminalLines(wrapped)).toEqual([
      { text: "[go-run] go run main.go", firstRow: 0, lastRow: 1 },
      { text: "0 apple", firstRow: 2, lastRow: 2 },
      { text: "1 banana banana banana", firstRow: 3, lastRow: 4 },
    ]);
  });

  it("reads past a missing row the way it always has", () => {
    // A missing row neither starts a line nor ends one; a trailing missing row
    // leaves lastRow on the last row the buffer has.
    const holed = bufferOf([
      row("[go-run] go run main"),
      undefined,
      row(".go", true),
      row("0 apple"),
      undefined,
    ]);
    expect(logicalTerminalLines(holed)).toEqual([
      { text: "[go-run] go run main.go", firstRow: 0, lastRow: 2 },
      { text: "0 apple", firstRow: 3, lastRow: 3 },
    ]);
  });

  it("starts with a continuation row left by trimmed scrollback", () => {
    const trimmed = bufferOf([row("na", true), row("0 apple")]);
    expect(logicalTerminalLines(trimmed)).toEqual([
      { text: "na", firstRow: 0, lastRow: 0 },
      { text: "0 apple", firstRow: 1, lastRow: 1 },
    ]);
  });
});
