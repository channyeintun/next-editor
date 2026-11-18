// The interactive line editor: decodes raw terminal input (UTF-8 across chunk
// boundaries, escape sequences, bracketed paste) into editing keys, keeps the
// line, cursor and history position, and redraws the prompt and line —
// wrapped over several terminal rows when it is wider than the terminal.
// It knows nothing about the shell: the host supplies output, the width and
// completions.

/** What the editor needs from its host. */
export interface EditorHost {
  /** Writes to the terminal (`\n` is turned into `\r\n` by the terminal). */
  write(text: string): void;
  /** The terminal width in columns. */
  columns(): number;
  /** Completions for the word ending at `cursor`: where it starts and the candidates. */
  complete(line: string, cursor: number): { start: number; candidates: string[] };
}

/** How reading a line ended. */
export type EditResult = { type: "line"; text: string } | { type: "eof" } | { type: "interrupt" };

/** Previous lines, oldest first. */
export class History {
  entries: string[] = [];
  readonly limit: number;

  constructor(limit = 1000) {
    this.limit = limit;
  }

  /** Adds a line unless it is empty or repeats the last one. Returns true when added. */
  add(line: string): boolean {
    if (line.trim() === "" || this.entries[this.entries.length - 1] === line) {
      return false;
    }
    this.entries.push(line);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
    return true;
  }
}

const ESC = String.fromCharCode(27);
/** A CSI sequence such as a colour: no width. */
const ANSI_SEQUENCE = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");
/** The start of an escape sequence whose rest has not arrived yet. */
const PARTIAL_SEQUENCE = new RegExp(`^${ESC}(\\[[0-9;]*|O)?$`);
/** Any escape sequence, to skip one the editor does not know. */
const UNKNOWN_SEQUENCE = new RegExp(`^${ESC}(\\[[0-9;?]*[ -/]*[@-~]|O.|.)`);

/** The number of terminal columns a code point takes. */
export function charWidth(codePoint: number): number {
  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }
  // Combining marks and zero-width characters.
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    codePoint === 0x200b ||
    codePoint === 0x200c ||
    codePoint === 0x200d
  ) {
    return 0;
  }
  // The wide ranges of xterm's default (Unicode 6) widths, which the site's
  // shell terminal keeps: the cursor moves by the cells xterm gives a
  // character, so emoji such as 🚀 or 😀 are 1 column there however wide
  // their glyph is drawn.
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3040 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x2fffd) ||
    (codePoint >= 0x30000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** The display width of text, ignoring ANSI escape sequences. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text.replace(ANSI_SEQUENCE, "")) {
    width += charWidth(ch.codePointAt(0) as number);
  }
  return width;
}

const KEYS: [string, string][] = [
  ["\x1b[200~", "paste-start"],
  ["\x1b[201~", "paste-end"],
  ["\x1b[1;5D", "word-left"],
  ["\x1b[1;3D", "word-left"],
  ["\x1b[1;9D", "word-left"],
  ["\x1b[1;5C", "word-right"],
  ["\x1b[1;3C", "word-right"],
  ["\x1b[1;9C", "word-right"],
  ["\x1b[3;5~", "delete-word-right"],
  ["\x1b[3~", "delete"],
  ["\x1b[1~", "home"],
  ["\x1b[7~", "home"],
  ["\x1b[4~", "end"],
  ["\x1b[8~", "end"],
  ["\x1b[5~", "ignore"],
  ["\x1b[6~", "ignore"],
  ["\x1b[2~", "ignore"],
  ["\x1b[A", "up"],
  ["\x1b[B", "down"],
  ["\x1b[C", "right"],
  ["\x1b[D", "left"],
  ["\x1b[H", "home"],
  ["\x1b[F", "end"],
  ["\x1b[Z", "ignore"],
  ["\x1bOA", "up"],
  ["\x1bOB", "down"],
  ["\x1bOC", "right"],
  ["\x1bOD", "left"],
  ["\x1bOH", "home"],
  ["\x1bOF", "end"],
  ["\x1bb", "word-left"],
  ["\x1bf", "word-right"],
  ["\x1bd", "delete-word-right"],
  ["\x1b\x7f", "delete-word-left"],
  ["\x1b\x08", "delete-word-left"],
  ["\r\n", "enter"],
  ["\r", "enter"],
  ["\n", "enter"],
  ["\x7f", "backspace"],
  ["\x08", "backspace"],
  ["\x01", "home"],
  ["\x05", "end"],
  ["\x02", "left"],
  ["\x06", "right"],
  ["\x10", "up"],
  ["\x0e", "down"],
  ["\x15", "kill-start"],
  ["\x0b", "kill-end"],
  ["\x17", "delete-word-left"],
  ["\x0c", "clear"],
  ["\x03", "interrupt"],
  ["\x04", "eof"],
  ["\t", "tab"],
];

/** Edits one line at a time in a raw-mode terminal. */
export class LineEditor {
  private readonly host: EditorHost;
  readonly history: History;
  /** The line being edited, as code points. */
  private chars: string[] = [];
  private cursor = 0;
  private prompt = "";
  private promptWidth = 0;
  /** Rows between the first row of the prompt and the terminal cursor. */
  private cursorRow = 0;
  private historyIndex = 0;
  private draft: string[] = [];
  private pasting = false;
  private lastKeyWasTab = false;
  /** Undecoded input: an escape sequence split across chunks. */
  private pending = "";
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private resolve: ((result: EditResult) => void) | null = null;
  /** Keys that arrived after a line ended, for the next line. */
  private queued = "";

  constructor(host: EditorHost, history = new History()) {
    this.host = host;
    this.history = history;
  }

  /** The current line text (for tests and the host). */
  get line(): string {
    return this.chars.join("");
  }

  /** The cursor position in code points. */
  get cursorIndex(): number {
    return this.cursor;
  }

  /** True while a line is being read. */
  get active(): boolean {
    return this.resolve !== null;
  }

  /** Shows `prompt` and reads one line. */
  readLine(prompt: string): Promise<EditResult> {
    this.prompt = prompt;
    this.promptWidth = displayWidth(prompt);
    this.chars = [];
    this.cursor = 0;
    this.cursorRow = 0;
    this.historyIndex = this.history.entries.length;
    this.draft = [];
    this.lastKeyWasTab = false;
    const promise = new Promise<EditResult>((resolve) => {
      this.resolve = resolve;
    });
    this.host.write(prompt);
    const queued = this.queued;
    this.queued = "";
    if (queued) {
      this.process(queued);
    }
    return promise;
  }

  /**
   * Takes the keys that arrived after the line that ended (typed ahead), for
   * the host to hand to whoever reads next; the next line starts without them.
   */
  takeTypeAhead(): string {
    const text = this.queued + this.pending;
    this.queued = "";
    this.pending = "";
    // They go back as the keys they were: a paste still open is over for the
    // editor, and its end marker, when it comes, is a key to ignore.
    this.pasting = false;
    return text;
  }

  /** Feeds raw terminal bytes. */
  feed(bytes: Uint8Array): void {
    this.process(this.decoder.decode(bytes, { stream: true }));
  }

  /** Feeds already-decoded input. */
  feedText(text: string): void {
    this.process(text);
  }

  /**
   * The input has ended: the line being read is given up, whatever is on
   * it, and its read ends as an end of file ends one.
   */
  endInput(): void {
    if (this.resolve) {
      this.host.write("\n");
      this.finish({ type: "eof" });
    }
  }

  /** Redraws after the terminal changed size. */
  resize(): void {
    if (!this.resolve) {
      return;
    }
    // The terminal reflows wrapped rows; find where the cursor ended up.
    const columns = Math.max(1, this.host.columns());
    this.cursorRow = Math.floor((this.promptWidth + this.widthOf(0, this.cursor)) / columns);
    this.refresh();
  }

  private finish(result: EditResult): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(result);
  }

  private process(text: string): void {
    let input = this.pending + text;
    this.pending = "";
    while (input.length > 0) {
      if (!this.resolve) {
        this.queued += input;
        return;
      }
      if (this.pasting) {
        const end = input.indexOf("\x1b[201~");
        const chunk = end < 0 ? input : input.slice(0, end);
        // Hold back a possible partial end marker.
        let usable = chunk;
        if (end < 0) {
          for (let k = Math.min(5, chunk.length); k > 0; k--) {
            if ("\x1b[201~".startsWith(chunk.slice(-k))) {
              usable = chunk.slice(0, -k);
              this.pending = chunk.slice(-k);
              break;
            }
          }
        }
        input = end < 0 ? "" : input.slice(end + 6);
        if (end >= 0) {
          this.pasting = false;
        }
        this.paste(usable);
        if (end < 0) {
          return;
        }
        continue;
      }
      if (input[0] === "\x1b") {
        const match = KEYS.find(([sequence]) => input.startsWith(sequence));
        if (match) {
          input = input.slice(match[0].length);
          this.key(match[1]);
          continue;
        }
        // A sequence that may still be arriving.
        if (input.length < 8 && PARTIAL_SEQUENCE.test(input)) {
          this.pending = input;
          return;
        }
        // An unknown sequence: skip it whole.
        const unknown = UNKNOWN_SEQUENCE.exec(input);
        input = input.slice(unknown ? unknown[0].length : 1);
        continue;
      }
      const match = KEYS.find(([sequence]) => input.startsWith(sequence));
      if (match) {
        input = input.slice(match[0].length);
        this.key(match[1]);
        continue;
      }
      const codePoint = input.codePointAt(0) as number;
      const ch = String.fromCodePoint(codePoint);
      input = input.slice(ch.length);
      if (codePoint < 32) {
        continue;
      }
      this.insert([ch]);
    }
  }

  private paste(text: string): void {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    for (let index = 0; index < lines.length; index++) {
      if (index > 0) {
        this.key("enter");
        if (!this.resolve) {
          // The rest of the paste is type-ahead for the next line, which
          // goes on pasting when the paste's end has not come yet.
          this.queued += lines.slice(index).join("\n");
          return;
        }
      }
      const chars = Array.from(lines[index]).filter(
        (c) => c === "\t" || (c.codePointAt(0) as number) >= 32,
      );
      if (chars.length > 0) {
        this.insert(chars);
      }
    }
  }

  private insert(chars: string[]): void {
    this.chars.splice(this.cursor, 0, ...chars);
    this.cursor += chars.length;
    this.lastKeyWasTab = false;
    this.refresh();
  }

  private key(name: string): void {
    const wasTab = this.lastKeyWasTab;
    this.lastKeyWasTab = false;
    switch (name) {
      case "paste-start":
        this.pasting = true;
        return;
      case "paste-end":
      case "ignore":
        return;
      case "enter": {
        this.cursor = this.chars.length;
        this.refresh();
        this.host.write("\n");
        const text = this.line;
        this.finish({ type: "line", text });
        return;
      }
      case "interrupt":
        this.cursor = this.chars.length;
        this.refresh();
        this.host.write("^C\n");
        this.finish({ type: "interrupt" });
        return;
      case "eof":
        if (this.chars.length === 0) {
          this.host.write("\n");
          this.finish({ type: "eof" });
          return;
        }
        if (this.cursor < this.chars.length) {
          this.chars.splice(this.cursor, 1);
          this.refresh();
        }
        return;
      case "backspace":
        if (this.cursor > 0) {
          this.chars.splice(this.cursor - 1, 1);
          this.cursor--;
          this.refresh();
        }
        return;
      case "delete":
        if (this.cursor < this.chars.length) {
          this.chars.splice(this.cursor, 1);
          this.refresh();
        }
        return;
      case "left":
        if (this.cursor > 0) {
          this.cursor--;
          this.refresh();
        }
        return;
      case "right":
        if (this.cursor < this.chars.length) {
          this.cursor++;
          this.refresh();
        }
        return;
      case "home":
        this.cursor = 0;
        this.refresh();
        return;
      case "end":
        this.cursor = this.chars.length;
        this.refresh();
        return;
      case "word-left":
        this.cursor = this.wordStart(this.cursor);
        this.refresh();
        return;
      case "word-right":
        this.cursor = this.wordEnd(this.cursor);
        this.refresh();
        return;
      case "delete-word-left": {
        const start = this.wordStart(this.cursor);
        this.chars.splice(start, this.cursor - start);
        this.cursor = start;
        this.refresh();
        return;
      }
      case "delete-word-right": {
        const end = this.wordEnd(this.cursor);
        this.chars.splice(this.cursor, end - this.cursor);
        this.refresh();
        return;
      }
      case "kill-start":
        this.chars.splice(0, this.cursor);
        this.cursor = 0;
        this.refresh();
        return;
      case "kill-end":
        this.chars.splice(this.cursor);
        this.refresh();
        return;
      case "clear":
        this.host.write("\x1b[H\x1b[2J");
        this.cursorRow = 0;
        this.refresh();
        return;
      case "up":
        this.historyMove(-1);
        return;
      case "down":
        this.historyMove(1);
        return;
      case "tab":
        this.lastKeyWasTab = true;
        this.completeWord(wasTab);
        return;
    }
  }

  private isWordChar(ch: string | undefined): boolean {
    return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
  }

  private wordStart(from: number): number {
    let i = from;
    while (i > 0 && !this.isWordChar(this.chars[i - 1])) {
      i--;
    }
    while (i > 0 && this.isWordChar(this.chars[i - 1])) {
      i--;
    }
    return i;
  }

  private wordEnd(from: number): number {
    let i = from;
    while (i < this.chars.length && !this.isWordChar(this.chars[i])) {
      i++;
    }
    while (i < this.chars.length && this.isWordChar(this.chars[i])) {
      i++;
    }
    return i;
  }

  private historyMove(delta: number): void {
    const entries = this.history.entries;
    const next = this.historyIndex + delta;
    if (next < 0 || next > entries.length) {
      return;
    }
    if (this.historyIndex === entries.length) {
      this.draft = [...this.chars];
    }
    this.historyIndex = next;
    this.chars = next === entries.length ? [...this.draft] : Array.from(entries[next]);
    this.cursor = this.chars.length;
    this.refresh();
  }

  private completeWord(secondTab: boolean): void {
    const line = this.line;
    const cursorOffset = this.chars.slice(0, this.cursor).join("").length;
    const { start, candidates } = this.host.complete(line, cursorOffset);
    if (candidates.length === 0) {
      this.host.write("\x07");
      return;
    }
    const word = line.slice(start, cursorOffset);
    let prefix = candidates[0];
    for (const candidate of candidates.slice(1)) {
      let i = 0;
      while (i < prefix.length && i < candidate.length && prefix[i] === candidate[i]) {
        i++;
      }
      prefix = prefix.slice(0, i);
    }
    if (candidates.length === 1) {
      const completion = candidates[0];
      const suffix = completion.endsWith("/") ? "" : " ";
      this.replaceRange(start, cursorOffset, completion + suffix);
      return;
    }
    if (prefix.length > word.length) {
      this.replaceRange(start, cursorOffset, prefix);
      return;
    }
    if (!secondTab) {
      this.host.write("\x07");
      return;
    }
    this.listCandidates(candidates);
  }

  private replaceRange(start: number, end: number, text: string): void {
    const line = this.line;
    const before = Array.from(line.slice(0, start));
    const after = Array.from(line.slice(end));
    const inserted = Array.from(text);
    this.chars = [...before, ...inserted, ...after];
    this.cursor = before.length + inserted.length;
    this.refresh();
  }

  private listCandidates(candidates: string[]): void {
    const columns = Math.max(1, this.host.columns());
    const names = candidates.map((candidate) => {
      const trimmed = candidate.endsWith("/") ? candidate.slice(0, -1) : candidate;
      const slash = trimmed.lastIndexOf("/");
      return slash >= 0 ? candidate.slice(slash + 1) : candidate;
    });
    const width = Math.max(...names.map(displayWidth)) + 2;
    const perRow = Math.max(1, Math.floor(columns / width));
    const rows = Math.ceil(names.length / perRow);
    let out = "";
    for (let r = 0; r < rows; r++) {
      let line = "";
      for (let c = 0; c < perRow; c++) {
        const index = c * rows + r;
        if (index < names.length) {
          const name = names[index];
          line +=
            c === perRow - 1 || (c + 1) * rows + r >= names.length
              ? name
              : name + " ".repeat(width - displayWidth(name));
        }
      }
      out += `${line}\n`;
    }
    // Leave the edited line where it is and print the list below it.
    this.moveToEnd();
    this.host.write(`\n${out}`);
    this.cursorRow = 0;
    this.refresh();
  }

  private widthOf(from: number, to: number): number {
    let width = 0;
    for (let i = from; i < to; i++) {
      width += charWidth(this.chars[i].codePointAt(0) as number);
    }
    return width;
  }

  private moveToEnd(): void {
    const columns = Math.max(1, this.host.columns());
    const total = this.promptWidth + this.widthOf(0, this.chars.length);
    const endRow = Math.floor(Math.max(0, total - 1) / columns);
    if (endRow > this.cursorRow) {
      this.host.write(`\x1b[${endRow - this.cursorRow}B`);
    }
    this.cursorRow = endRow;
  }

  /** Redraws the prompt and line, then puts the terminal cursor at the edit position. */
  private refresh(): void {
    const columns = Math.max(1, this.host.columns());
    let out = "";
    if (this.cursorRow > 0) {
      out += `\x1b[${this.cursorRow}A`;
    }
    out += `\r${this.prompt}${this.line}\x1b[J`;
    const total = this.promptWidth + this.widthOf(0, this.chars.length);
    const endRow = Math.floor(total / columns);
    if (total > 0 && total % columns === 0) {
      // The terminal holds the cursor in the last column until the next character: move it down now.
      out += "\n";
    }
    const position = this.promptWidth + this.widthOf(0, this.cursor);
    const targetRow = Math.floor(position / columns);
    const targetColumn = position % columns;
    if (endRow > targetRow) {
      out += `\x1b[${endRow - targetRow}A`;
    }
    out += "\r";
    if (targetColumn > 0) {
      out += `\x1b[${targetColumn}C`;
    }
    this.cursorRow = targetRow;
    this.host.write(out);
  }
}
