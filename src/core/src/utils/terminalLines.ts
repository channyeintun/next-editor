/**
 * Reading an xterm terminal's buffer as the lines that were written to it. A
 * long line wraps over several buffer rows; grouping them back gives indices
 * that stay the same however wide the terminal is, which is what lets a cursor
 * sample point at "line 4, character 8" instead of at a pixel offset.
 *
 * Only the structural parts of xterm's buffer API are named here, so core
 * stays free of xterm and tests can hand in a plain fake.
 */

export interface TerminalBufferCell {
  getChars(): string;
  getWidth(): number;
}

export interface TerminalBufferLine {
  readonly isWrapped: boolean;
  readonly length: number;
  translateToString(trimRight?: boolean): string;
  getCell(x: number): TerminalBufferCell | undefined;
}

export interface TerminalBuffer {
  readonly length: number;
  readonly viewportY: number;
  getLine(y: number): TerminalBufferLine | undefined;
}

/** One line as it was written to the terminal, before wrapping. */
export interface LogicalTerminalLine {
  text: string;
  firstRow: number;
  lastRow: number;
}

/**
 * The rows that start a written line, in order: every row xterm has that is
 * not the wrapped continuation of the row above. The first row present always
 * starts one, even when its own line began in scrollback that was trimmed.
 * Index i is written line i, which is how a cursor cell anchor numbers lines.
 */
export function writtenLineStarts(buffer: TerminalBuffer): number[] {
  const starts: number[] = [];
  for (let row = 0; row < buffer.length; row++) {
    const bufferLine = buffer.getLine(row);
    if (!bufferLine) continue;
    if (!bufferLine.isWrapped || starts.length === 0) starts.push(row);
  }
  return starts;
}

/** The written line holding `row`, and the row it starts on; null above the first line. */
export function writtenLineAtRow(
  starts: readonly number[],
  row: number,
): { line: number; firstRow: number } | null {
  // The last start at or before the row.
  let low = 0;
  let high = starts.length - 1;
  let line = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (starts[mid] <= row) {
      line = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return line < 0 ? null : { line, firstRow: starts[line] };
}

/** The row written line `line` starts on, or null when there is no such line. */
export function firstRowOfWrittenLine(starts: readonly number[], line: number): number | null {
  return starts[line] ?? null;
}

/** Group the buffer's rows back into the lines that were written. */
export function logicalTerminalLines(buffer: TerminalBuffer): LogicalTerminalLine[] {
  const starts = writtenLineStarts(buffer);
  return starts.map((firstRow, index) => {
    const end = starts[index + 1] ?? buffer.length;
    let text = "";
    let lastRow = firstRow;
    for (let row = firstRow; row < end; row++) {
      const bufferLine = buffer.getLine(row);
      if (!bufferLine) continue;
      text += bufferLine.translateToString(true);
      lastRow = row;
    }
    return { text, firstRow, lastRow };
  });
}

/** Column just past the last visible character of a row (0 for a blank row). */
export function endColumnOf(bufferLine: TerminalBufferLine): number {
  for (let x = bufferLine.length - 1; x >= 0; x--) {
    const cell = bufferLine.getCell(x);
    const chars = cell?.getChars() ?? "";
    // The second half of a wide character is an empty, zero-width cell.
    if (chars.trim() !== "") {
      return x + Math.max(1, cell!.getWidth());
    }
  }
  return 0;
}
