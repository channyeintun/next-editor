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

/** Group the buffer's rows back into the lines that were written. */
export function logicalTerminalLines(buffer: TerminalBuffer): LogicalTerminalLine[] {
  const lines: LogicalTerminalLine[] = [];
  for (let row = 0; row < buffer.length; row++) {
    const bufferLine = buffer.getLine(row);
    if (!bufferLine) continue;
    const text = bufferLine.translateToString(true);
    const current = lines.at(-1);
    if (bufferLine.isWrapped && current) {
      current.text += text;
      current.lastRow = row;
    } else {
      lines.push({ text, firstRow: row, lastRow: row });
    }
  }
  return lines;
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
