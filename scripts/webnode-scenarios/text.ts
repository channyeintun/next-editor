// What a scenario compares a terminal's output with: the text without the
// terminal's control sequences.
const ESCAPE = String.fromCharCode(27);
const CONTROL_SEQUENCE = new RegExp(`${ESCAPE}\\[[0-9;?]*[A-Za-z]`, "g");

/** `text` without the terminal's control sequences. */
export function withoutControlSequences(text: string): string {
  return text.replace(CONTROL_SEQUENCE, "");
}

/** `text` as plain lines: no control sequences and no carriage returns. */
export function plainText(text: string): string {
  return withoutControlSequences(text).replace(/\r/g, "");
}
