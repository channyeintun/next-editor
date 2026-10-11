/**
 * Width and size budget for the workspace text that read and grep hand back to
 * the model. A workspace can hold a minified bundle, a source map or an inline
 * data URI on one line; returned whole (and by grep once per match), one call
 * could overflow the model's context and stayed in the chat recording. bash
 * caps its own output stream separately.
 */
export const MAX_TOOL_LINE_CHARS = 2_000;
export const MAX_TOOL_OUTPUT_CHARS = 100_000;

/** Clips one line to MAX_TOOL_LINE_CHARS, noting how many characters it left out. */
export function clipLine(line: string): string {
  if (line.length <= MAX_TOOL_LINE_CHARS) {
    return line;
  }

  let end = MAX_TOOL_LINE_CHARS;
  // Do not split a surrogate pair: a lone half is not valid text.
  const lastCode = line.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }
  return `${line.slice(0, end)}… [${line.length - end} chars omitted]`;
}

/**
 * Joins lines with "\n" until the next one would pass MAX_TOOL_OUTPUT_CHARS.
 * omittedLines counts the lines left out, so the caller can say where to
 * continue.
 */
export function capOutputLines(lines: string[]): { text: string; omittedLines: number } {
  let length = 0;
  let count = 0;

  for (const line of lines) {
    const next = length + (count > 0 ? 1 : 0) + line.length;
    if (next > MAX_TOOL_OUTPUT_CHARS) {
      break;
    }
    length = next;
    count += 1;
  }

  return { text: lines.slice(0, count).join("\n"), omittedLines: lines.length - count };
}
