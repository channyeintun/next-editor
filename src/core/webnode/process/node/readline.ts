// The `readline` builtin and the implementation behind `readline/promises`:
// a port of Node 22's lib/readline.js and lib/internal/readline/{interface,
// utils,callbacks,emitKeypressEvents,promises}.js. Line splitting on
// `\n`/`\r\n`/`\r` with `crlfDelay`, terminal line editing driven by
// `keypress` events (Node's escape-sequence parser `emitKeys`), history, tab
// completion, `question`, async iteration, and the ANSI cursor helpers.
// Differences: callbacks Node defers with `process.nextTick` are deferred with
// `queueMicrotask`; Ctrl+Z with no `SIGTSTP` listener does nothing (a browser
// has no job control); there is no kill ring (Ctrl+Y).
import type { EventEmitter as EventEmitterInstance } from "./events";
import EventEmitter, { addAbortListener } from "./events";
import {
  AbortError,
  invalidArgType,
  invalidArgValue,
  makeNodeError,
  validateAbortSignal,
  validateBoolean,
  validateFunction,
  validateInteger,
  validateString,
} from "./internalErrors";
import { StringDecoder } from "./string_decoder";
import { inspect, stripVTControlCharacters } from "./util";
import { runtime } from "../runtime";

// ---------------------------------------------------------------------------
// lib/internal/readline/utils.js

const kUTF16SurrogateThreshold = 0x10000;
const kEscape = "\x1b";
const kClearToLineBeginning = "\x1b[1K";
const kClearToLineEnd = "\x1b[0K";
const kClearLine = "\x1b[2K";
const kClearScreenDown = "\x1b[0J";

function charLengthLeft(str: string, i: number): number {
  if (i <= 0) {
    return 0;
  }
  if (
    (i > 1 && (str.codePointAt(i - 2) as number) >= kUTF16SurrogateThreshold) ||
    (str.codePointAt(i - 1) as number) >= kUTF16SurrogateThreshold
  ) {
    return 2;
  }
  return 1;
}

function charLengthAt(str: string, i: number): number {
  if (str.length <= i) {
    // Pretend to move to the right. This is necessary to autocomplete while
    // moving to the right.
    return 1;
  }
  return (str.codePointAt(i) as number) >= kUTF16SurrogateThreshold ? 2 : 1;
}

function isFullWidthCodePoint(code: number): boolean {
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0x3247 && code !== 0x303f) ||
      (code >= 0x3250 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0xa4c6) ||
      (code >= 0xa960 && code <= 0xa97c) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6b) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1b000 && code <= 0x1b001) ||
      (code >= 0x1f200 && code <= 0x1f251) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x20000 && code <= 0x3fffd))
  );
}

function isZeroWidthCodePoint(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x300 && code <= 0x36f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xfe20 && code <= 0xfe2f) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  );
}

/** Columns `str` takes in a terminal (Node's non-ICU `getStringWidth`). */
function getStringWidth(str: string, removeControlChars = true): number {
  let width = 0;
  if (removeControlChars) {
    str = stripVTControlCharacters(str);
  }
  for (const char of str) {
    const code = char.codePointAt(0) as number;
    if (isFullWidthCodePoint(code)) {
      width += 2;
    } else if (!isZeroWidthCodePoint(code)) {
      width++;
    }
  }
  return width;
}

function commonPrefix(strings: string[]): string {
  if (strings.length === 0) {
    return "";
  }
  if (strings.length === 1) {
    return strings[0];
  }
  const sorted = [...strings].sort();
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  for (let i = 0; i < min.length; i++) {
    if (min[i] !== max[i]) {
      return min.slice(0, i);
    }
  }
  return min;
}

/** A parsed key, as `keypress` listeners receive it. */
export interface Key {
  sequence: string | null;
  name: string | undefined;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  code?: string;
}

const KEY_NAMES: Readonly<Record<string, string>> = {
  "[P": "f1",
  "[Q": "f2",
  "[R": "f3",
  "[S": "f4",
  OP: "f1",
  OQ: "f2",
  OR: "f3",
  OS: "f4",
  "[11~": "f1",
  "[12~": "f2",
  "[13~": "f3",
  "[14~": "f4",
  "[200~": "paste-start",
  "[201~": "paste-end",
  "[[A": "f1",
  "[[B": "f2",
  "[[C": "f3",
  "[[D": "f4",
  "[[E": "f5",
  "[15~": "f5",
  "[17~": "f6",
  "[18~": "f7",
  "[19~": "f8",
  "[20~": "f9",
  "[21~": "f10",
  "[23~": "f11",
  "[24~": "f12",
  "[A": "up",
  "[B": "down",
  "[C": "right",
  "[D": "left",
  "[E": "clear",
  "[F": "end",
  "[H": "home",
  OA: "up",
  OB: "down",
  OC: "right",
  OD: "left",
  OE: "clear",
  OF: "end",
  OH: "home",
  "[1~": "home",
  "[2~": "insert",
  "[3~": "delete",
  "[4~": "end",
  "[5~": "pageup",
  "[6~": "pagedown",
  "[[5~": "pageup",
  "[[6~": "pagedown",
  "[7~": "home",
  "[8~": "end",
};

/** Codes whose name comes with a forced modifier: [name, "shift" | "ctrl"]. */
const MODIFIED_KEY_NAMES: Readonly<Record<string, readonly [string, "shift" | "ctrl"]>> = {
  "[a": ["up", "shift"],
  "[b": ["down", "shift"],
  "[c": ["right", "shift"],
  "[d": ["left", "shift"],
  "[e": ["clear", "shift"],
  "[2$": ["insert", "shift"],
  "[3$": ["delete", "shift"],
  "[5$": ["pageup", "shift"],
  "[6$": ["pagedown", "shift"],
  "[7$": ["home", "shift"],
  "[8$": ["end", "shift"],
  Oa: ["up", "ctrl"],
  Ob: ["down", "ctrl"],
  Oc: ["right", "ctrl"],
  Od: ["left", "ctrl"],
  Oe: ["clear", "ctrl"],
  "[2^": ["insert", "ctrl"],
  "[3^": ["delete", "ctrl"],
  "[5^": ["pageup", "ctrl"],
  "[6^": ["pagedown", "ctrl"],
  "[7^": ["home", "ctrl"],
  "[8^": ["end", "ctrl"],
  "[Z": ["tab", "shift"],
};

/**
 * Node's `emitKeys`: a generator fed one character at a time that emits
 * `keypress` on `stream` for each complete key or escape sequence.
 */
function* emitKeys(stream: EventEmitterInstance): Generator<void, never, string> {
  while (true) {
    let ch: string = yield;
    let s = ch;
    let escaped = false;
    const key: Key = { sequence: null, name: undefined, ctrl: false, meta: false, shift: false };

    if (ch === kEscape) {
      escaped = true;
      s += ch = yield;
      if (ch === kEscape) {
        s += ch = yield;
      }
    }

    if (escaped && (ch === "O" || ch === "[")) {
      // ANSI escape sequence
      let code = ch;
      let modifier = 0;

      if (ch === "O") {
        // ESC O letter / ESC O modifier letter
        s += ch = yield;
        if (ch >= "0" && ch <= "9") {
          modifier = (Number(ch) >> 0) - 1;
          s += ch = yield;
        }
        code += ch;
      } else if (ch === "[") {
        // ESC [ letter / ESC [ modifier letter / ESC [ [ modifier letter / ESC [ [ num char
        s += ch = yield;
        if (ch === "[") {
          code += ch;
          s += ch = yield;
        }
        const cmdStart = s.length - 1;
        // Skip one to three leading digits.
        if (ch >= "0" && ch <= "9") {
          s += ch = yield;
          if (ch >= "0" && ch <= "9") {
            s += ch = yield;
            if (ch >= "0" && ch <= "9") {
              s += ch = yield;
            }
          }
        }
        // Skip the modifier.
        if (ch === ";") {
          s += ch = yield;
          if (ch >= "0" && ch <= "9") {
            s += yield;
          }
        }
        const cmd = s.slice(cmdStart);
        let match: RegExpExecArray | null;
        if ((match = /^(?:(\d\d?)(?:;(\d))?([~^$])|(\d{3}~))$/.exec(cmd))) {
          if (match[4]) {
            code += match[4];
          } else {
            code += match[1] + match[3];
            modifier = Number(match[2] || 1) - 1;
          }
        } else if ((match = /^((\d;)?(\d))?([A-Za-z])$/.exec(cmd))) {
          code += match[4];
          modifier = Number(match[3] || 1) - 1;
        } else {
          code += cmd;
        }
      }

      key.ctrl = !!(modifier & 4);
      key.meta = !!(modifier & 10);
      key.shift = !!(modifier & 1);
      key.code = code;

      const modified = Object.hasOwn(MODIFIED_KEY_NAMES, code) ? MODIFIED_KEY_NAMES[code] : null;
      if (modified !== null) {
        key.name = modified[0];
        key[modified[1]] = true;
      } else {
        key.name = Object.hasOwn(KEY_NAMES, code) ? KEY_NAMES[code] : "undefined";
      }
    } else if (ch === "\r") {
      key.name = "return";
      key.meta = escaped;
    } else if (ch === "\n") {
      key.name = "enter";
      key.meta = escaped;
    } else if (ch === "\t") {
      key.name = "tab";
      key.meta = escaped;
    } else if (ch === "\b" || ch === "\x7f") {
      key.name = "backspace";
      key.meta = escaped;
    } else if (ch === kEscape) {
      key.name = "escape";
      key.meta = escaped;
    } else if (ch === " ") {
      key.name = "space";
      key.meta = escaped;
    } else if (!escaped && ch <= "\x1a") {
      // ctrl+letter
      key.name = String.fromCharCode(ch.charCodeAt(0) + "a".charCodeAt(0) - 1);
      key.ctrl = true;
    } else if (/^[0-9A-Za-z]$/.exec(ch) !== null) {
      // Letter, number, shift+letter
      key.name = ch.toLowerCase();
      key.shift = /^[A-Z]$/.exec(ch) !== null;
      key.meta = escaped;
    } else if (escaped) {
      // Escape sequence timeout
      key.name = ch.length ? undefined : "escape";
      key.meta = true;
    }

    key.sequence = s;

    if (s.length !== 0 && (key.name !== undefined || escaped)) {
      // Named character or sequence
      stream.emit("keypress", escaped ? undefined : s, key);
    } else if (charLengthAt(s, 0) === s.length) {
      // Single unnamed character, e.g. "."
      stream.emit("keypress", s, key);
    }
    // Unrecognized or broken escape sequence: nothing is emitted.
  }
}

// ---------------------------------------------------------------------------
// lib/internal/readline/emitKeypressEvents.js

const ESCAPE_CODE_TIMEOUT = 500;
const kSawKeyPress = Symbol("_sawKeyPress");
const keypressStreams = new WeakSet<object>();

interface KeypressInterface {
  escapeCodeTimeout?: number;
  isCompletionEnabled?: boolean;
  [kSawKeyPress]?: boolean;
}

/** Makes `stream` emit `keypress` events for what it reads (parsed by `emitKeys`). */
export function emitKeypressEvents(stream: unknown, iface: KeypressInterface = {}): void {
  const emitter = stream as EventEmitterInstance;
  if (keypressStreams.has(emitter)) {
    return;
  }
  keypressStreams.add(emitter);
  const decoder = new StringDecoder("utf8");
  let escapeDecoder = emitKeys(emitter);
  escapeDecoder.next();
  const triggerEscape = () => escapeDecoder.next("");
  const escapeCodeTimeout = iface.escapeCodeTimeout ?? ESCAPE_CODE_TIMEOUT;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  function onData(input: string | Uint8Array): void {
    if (emitter.listenerCount("keypress") > 0) {
      const string = decoder.write(input as Buffer);
      if (string) {
        globalThis.clearTimeout(timeoutId);
        // This supports characters of length 2.
        iface[kSawKeyPress] = charLengthAt(string, 0) === string.length;
        iface.isCompletionEnabled = false;
        let length = 0;
        for (const character of string) {
          length += character.length;
          if (length === string.length) {
            iface.isCompletionEnabled = true;
          }
          try {
            escapeDecoder.next(character);
            // Escape letter at the tail position
            if (length === string.length && character === kEscape) {
              timeoutId = globalThis.setTimeout(triggerEscape, escapeCodeTimeout);
            }
          } catch (error) {
            // A `keypress` listener threw: restart the generator.
            escapeDecoder = emitKeys(emitter);
            escapeDecoder.next();
            throw error;
          }
        }
      }
    } else {
      // Nobody's watching anyway
      emitter.removeListener("data", onData);
      emitter.on("newListener", onNewListener);
    }
  }

  function onNewListener(event: string | symbol): void {
    if (event === "keypress") {
      emitter.on("data", onData);
      emitter.removeListener("newListener", onNewListener);
    }
  }

  if (emitter.listenerCount("keypress") > 0) {
    emitter.on("data", onData);
  } else {
    emitter.on("newListener", onNewListener);
  }
}

// ---------------------------------------------------------------------------
// lib/internal/readline/callbacks.js

type Callback = (error?: Error | null) => void;
interface WritableLike {
  write(data: string, callback?: Callback): boolean;
}

function deferCallback(callback: unknown): void {
  if (typeof callback === "function") {
    queueMicrotask(() => (callback as (error: null) => void)(null));
  }
}

function invalidCursorPos(): Error {
  return makeNodeError(
    "ERR_INVALID_CURSOR_POS",
    "Cannot set cursor row without setting its column",
    TypeError,
  );
}

/** Moves the cursor to column `x` (and row `y`) of `stream`. */
export function cursorTo(stream: unknown, x: unknown, y?: unknown, callback?: unknown): boolean {
  if (callback !== undefined) {
    validateFunction(callback, "callback");
  }
  if (typeof y === "function") {
    callback = y;
    y = undefined;
  }
  if (Number.isNaN(x)) {
    throw invalidArgValue("x", x);
  }
  if (Number.isNaN(y)) {
    throw invalidArgValue("y", y);
  }
  if (stream == null || (typeof x !== "number" && typeof y !== "number")) {
    deferCallback(callback);
    return true;
  }
  if (typeof x !== "number") {
    throw invalidCursorPos();
  }
  const data = typeof y !== "number" ? `\x1b[${x + 1}G` : `\x1b[${y + 1};${x + 1}H`;
  return (stream as WritableLike).write(data, callback as Callback | undefined);
}

function moveData(dx: number, dy: number): string {
  let data = "";
  if (dx < 0) {
    data += `\x1b[${-dx}D`;
  } else if (dx > 0) {
    data += `\x1b[${dx}C`;
  }
  if (dy < 0) {
    data += `\x1b[${-dy}A`;
  } else if (dy > 0) {
    data += `\x1b[${dy}B`;
  }
  return data;
}

/** Moves the cursor of `stream` by `dx` columns and `dy` rows. */
export function moveCursor(stream: unknown, dx: unknown, dy: unknown, callback?: unknown): boolean {
  if (callback !== undefined) {
    validateFunction(callback, "callback");
  }
  if (stream == null || !(dx || dy)) {
    deferCallback(callback);
    return true;
  }
  return (stream as WritableLike).write(
    moveData(dx as number, dy as number),
    callback as Callback | undefined,
  );
}

/** Clears the current line of `stream`: left of the cursor (-1), right (1) or all (0). */
export function clearLine(stream: unknown, dir: unknown, callback?: unknown): boolean {
  if (callback !== undefined) {
    validateFunction(callback, "callback");
  }
  if (stream === null || stream === undefined) {
    deferCallback(callback);
    return true;
  }
  const type =
    (dir as number) < 0
      ? kClearToLineBeginning
      : (dir as number) > 0
        ? kClearToLineEnd
        : kClearLine;
  return (stream as WritableLike).write(type, callback as Callback | undefined);
}

/** Clears `stream` from the cursor down. */
export function clearScreenDown(stream: unknown, callback?: unknown): boolean {
  if (callback !== undefined) {
    validateFunction(callback, "callback");
  }
  if (stream === null || stream === undefined) {
    deferCallback(callback);
    return true;
  }
  return (stream as WritableLike).write(kClearScreenDown, callback as Callback | undefined);
}

// ---------------------------------------------------------------------------
// lib/internal/readline/interface.js

const kHistorySize = 30;
const kMaxUndoRedoStackSize = 2048;
const kMincrlfDelay = 100;
const lineEnding = /\r?\n|\r(?!\n)/g;

const kDispose =
  (Symbol as unknown as { dispose?: symbol }).dispose ?? Symbol.for("nodejs.dispose");

/** A completer: sync, returning a promise, or taking a callback. */
export type Completer =
  | ((line: string) => CompleterResult | Promise<CompleterResult>)
  | ((line: string, callback: (error: Error | null, result: CompleterResult) => void) => void);
/** `[completions, the substring that was completed]`. */
export type CompleterResult = [string[], string];

/** What `createInterface` accepts as an options object. */
export interface InterfaceOptions {
  input: unknown;
  output?: unknown;
  completer?: Completer;
  terminal?: boolean;
  history?: string[];
  historySize?: number;
  removeHistoryDuplicates?: boolean;
  prompt?: string;
  crlfDelay?: number;
  escapeCodeTimeout?: number;
  tabSize?: number;
  signal?: AbortSignal;
}

interface InputLike extends EventEmitterInstance {
  pause?(): unknown;
  resume?(): unknown;
  setRawMode?(mode: boolean): unknown;
  isRaw?: boolean;
}

interface OutputLike {
  write(data: string): unknown;
  on?(event: string, listener: () => void): unknown;
  removeListener?(event: string, listener: () => void): unknown;
  isTTY?: boolean;
  columns?: number;
}

interface UndoEntry {
  text: string;
  cursor: number;
}

const kDecoder = Symbol("_decoder");
const kLineBuffer = Symbol("_line_buffer");
const kOldPrompt = Symbol("_oldPrompt");
const kPreviousKey = Symbol("_previousKey");
const kQuestionCallback = Symbol("_questionCallback");
const kSawReturnAt = Symbol("_sawReturnAt");
const kSubstringSearch = Symbol("kSubstringSearch");
const kUndoStack = Symbol("_undoStack");
const kRedoStack = Symbol("_redoStack");
const kLineIterator = Symbol("kLineObjectStream");

function useAfterClose(): Error {
  return makeNodeError("ERR_USE_AFTER_CLOSE", "readline was closed");
}

function terminalEnvTerm(): string | undefined {
  try {
    return runtime().env.TERM;
  } catch {
    return undefined;
  }
}

/**
 * Node's `InterfaceConstructor`: everything the callback and promise
 * `Interface`s share. Its state is set by `initInterface`, so the legacy
 * function-style `Interface` can initialise an existing object too.
 */
export class InterfaceConstructor extends EventEmitter {
  declare input: InputLike;
  declare output: OutputLike | null | undefined;
  declare terminal: boolean;
  declare line: string;
  declare cursor: number;
  declare history: string[];
  declare historyIndex: number;
  declare historySize: number;
  declare removeHistoryDuplicates: boolean;
  declare crlfDelay: number;
  declare completer: Completer | undefined;
  declare closed: boolean;
  declare paused: boolean;
  declare prevRows: number;
  declare tabSize: number;
  declare escapeCodeTimeout: number;
  declare isCompletionEnabled: boolean;
  declare _prompt: string;
  declare [kSawKeyPress]: boolean;
  declare [kDecoder]: StringDecoder;
  declare [kLineBuffer]: string | null;
  declare [kOldPrompt]: string;
  declare [kPreviousKey]: Partial<Key> | null;
  declare [kQuestionCallback]: ((answer: string) => void) | null;
  declare [kSawReturnAt]: number;
  declare [kSubstringSearch]: string | null;
  declare [kUndoStack]: UndoEntry[];
  declare [kRedoStack]: UndoEntry[];
  declare [kLineIterator]: AsyncIterableIterator<string> | undefined;

  constructor(input: unknown, output?: unknown, completer?: unknown, terminal?: unknown) {
    super();
    initInterface(this, input, output, completer, terminal);
  }

  /** The output's width, or Infinity. */
  get columns(): number {
    if (this.output && this.output.columns) {
      return this.output.columns;
    }
    return Infinity;
  }

  setPrompt(prompt: string): void {
    this._prompt = prompt;
  }

  getPrompt(): string {
    return this._prompt;
  }

  _setRawMode(mode: boolean): boolean | undefined {
    const wasInRawMode = this.input.isRaw;
    if (typeof this.input.setRawMode === "function") {
      this.input.setRawMode(mode);
    }
    return wasInRawMode;
  }

  /** Writes the prompt (and, in a terminal, the current line). */
  prompt(preserveCursor?: boolean): void {
    if (this.paused) {
      this.resume();
    }
    if (this.terminal && terminalEnvTerm() !== "dumb") {
      if (!preserveCursor) {
        this.cursor = 0;
      }
      this._refreshLine();
    } else {
      this._writeToOutput(this._prompt);
    }
  }

  _question(query: string, cb: (answer: string) => void): void {
    if (this.closed) {
      throw useAfterClose();
    }
    if (this[kQuestionCallback]) {
      this.prompt();
    } else {
      this[kOldPrompt] = this._prompt;
      this.setPrompt(query);
      this[kQuestionCallback] = cb;
      this.prompt();
    }
  }

  _onLine(line: string): void {
    const callback = this[kQuestionCallback];
    if (callback) {
      this[kQuestionCallback] = null;
      this.setPrompt(this[kOldPrompt]);
      callback(line);
    } else {
      this.emit("line", line);
    }
  }

  _questionCancel(): void {
    if (this[kQuestionCallback]) {
      this[kQuestionCallback] = null;
      this.setPrompt(this[kOldPrompt]);
      this.clearLine();
    }
  }

  _writeToOutput(stringToWrite: string): void {
    validateString(stringToWrite, "stringToWrite");
    if (this.output !== null && this.output !== undefined) {
      this.output.write(stringToWrite);
    }
  }

  _addHistory(): string {
    if (this.line.length === 0) {
      return "";
    }
    if (this.historySize === 0) {
      return this.line;
    }
    if (this.line.trim().length === 0) {
      return this.line;
    }
    if (this.history.length === 0 || this.history[0] !== this.line) {
      if (this.removeHistoryDuplicates) {
        const dupIndex = this.history.indexOf(this.line);
        if (dupIndex !== -1) {
          this.history.splice(dupIndex, 1);
        }
      }
      this.history.unshift(this.line);
      if (this.history.length > this.historySize) {
        this.history.pop();
      }
    }
    this.historyIndex = -1;
    const line = this.history[0];
    this.emit("history", this.history);
    return line;
  }

  _refreshLine(): void {
    const line = this._prompt + this.line;
    const dispPos = this._getDisplayPos(line);
    const lineCols = dispPos.cols;
    const lineRows = dispPos.rows;
    const cursorPos = this.getCursorPos();
    // First move to the bottom of the current line, based on cursor pos.
    const prevRows = this.prevRows || 0;
    if (prevRows > 0) {
      moveCursor(this.output, 0, -prevRows);
    }
    cursorTo(this.output, 0);
    clearScreenDown(this.output);
    this._writeToOutput(line);
    // Force the terminal to allocate a new line.
    if (lineCols === 0) {
      this._writeToOutput(" ");
    }
    cursorTo(this.output, cursorPos.cols);
    const diff = lineRows - cursorPos.rows;
    if (diff > 0) {
      moveCursor(this.output, 0, -diff);
    }
    this.prevRows = cursorPos.rows;
  }

  /** Closes the interface: pauses the input, leaves raw mode, emits `close`. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.pause();
    if (this.terminal) {
      this._setRawMode(false);
    }
    this.closed = true;
    this.emit("close");
  }

  pause(): this | undefined {
    if (this.paused) {
      return undefined;
    }
    this.input.pause?.();
    this.paused = true;
    this.emit("pause");
    return this;
  }

  resume(): this | undefined {
    if (!this.paused) {
      return undefined;
    }
    this.input.resume?.();
    this.paused = false;
    this.emit("resume");
    return this;
  }

  /** Writes `data` (or the `key`) as if the user typed it. */
  write(data: unknown, key?: Partial<Key>): void {
    if (this.closed) {
      throw useAfterClose();
    }
    if (this.paused) {
      this.resume();
    }
    if (this.terminal) {
      this._ttyWrite(data as string | undefined, key);
    } else {
      this._normalWrite(data as string | Uint8Array | undefined);
    }
  }

  _normalWrite(b: string | Uint8Array | undefined): void {
    if (b === undefined) {
      return;
    }
    let string = this[kDecoder].write(b as Buffer);
    if (this[kSawReturnAt] && Date.now() - this[kSawReturnAt] <= this.crlfDelay) {
      if (string.codePointAt(0) === 10) {
        string = string.slice(1);
      }
      this[kSawReturnAt] = 0;
    }
    // Run the test on the new chunk, not on the entire line buffer.
    lineEnding.lastIndex = 0;
    let newPartContainsEnding = lineEnding.exec(string);
    if (newPartContainsEnding !== null) {
      if (this[kLineBuffer]) {
        string = this[kLineBuffer] + string;
        this[kLineBuffer] = null;
        lineEnding.lastIndex = 0;
        newPartContainsEnding = lineEnding.exec(string) as RegExpExecArray;
      }
      this[kSawReturnAt] = string.endsWith("\r") ? Date.now() : 0;
      const indexes = [0, newPartContainsEnding.index, lineEnding.lastIndex];
      let nextMatch: RegExpExecArray | null;
      while ((nextMatch = lineEnding.exec(string)) !== null) {
        indexes.push(nextMatch.index, lineEnding.lastIndex);
      }
      const lastIndex = indexes.length - 1;
      // Either '' or (conceivably) the unfinished portion of the next line.
      this[kLineBuffer] = string.slice(indexes[lastIndex]);
      for (let i = 1; i < lastIndex; i += 2) {
        this._onLine(string.slice(indexes[i - 1], indexes[i]));
        if (this.closed) {
          break;
        }
      }
    } else if (string) {
      // No newlines this time, save what we have for next time.
      if (this[kLineBuffer]) {
        this[kLineBuffer] += string;
      } else {
        this[kLineBuffer] = string;
      }
    }
  }

  _insertString(c: string): void {
    this._beforeEdit(this.line, this.cursor);
    if (this.cursor < this.line.length) {
      const beg = this.line.slice(0, this.cursor);
      const end = this.line.slice(this.cursor, this.line.length);
      this.line = beg + c + end;
      this.cursor += c.length;
      this._refreshLine();
    } else {
      const oldPos = this.getCursorPos();
      this.line += c;
      this.cursor += c.length;
      const newPos = this.getCursorPos();
      if (oldPos.rows < newPos.rows) {
        this._refreshLine();
      } else {
        this._writeToOutput(c);
      }
    }
  }

  async _tabComplete(lastKeypressWasTab: boolean): Promise<void> {
    this.pause();
    const string = this.line.slice(0, this.cursor);
    let value: CompleterResult;
    try {
      value = await callCompleter(this.completer as Completer, string);
    } catch (error) {
      this._writeToOutput(`Tab completion error: ${inspect(error)}`);
      return;
    } finally {
      this.resume();
    }
    this._tabCompleter(lastKeypressWasTab, value);
  }

  _tabCompleter(lastKeypressWasTab: boolean, value: CompleterResult): void {
    const [completions, completeOn] = value;
    if (!completions || completions.length === 0) {
      return;
    }
    // If there is a common prefix to all matches, then apply that portion.
    const prefix = commonPrefix(completions.filter((e) => e !== ""));
    if (prefix.startsWith(completeOn) && prefix.length > completeOn.length) {
      this._insertString(prefix.slice(completeOn.length));
      return;
    } else if (!completeOn.startsWith(prefix)) {
      this.line =
        this.line.slice(0, this.cursor - completeOn.length) +
        prefix +
        this.line.slice(this.cursor, this.line.length);
      this.cursor = this.cursor - completeOn.length + prefix.length;
      this._refreshLine();
      return;
    }
    if (!lastKeypressWasTab) {
      return;
    }
    this._beforeEdit(this.line, this.cursor);
    // Apply/show completions.
    const completionsWidth = completions.map((e) => getStringWidth(e));
    const width = Math.max(...completionsWidth) + 2; // 2 space padding
    let maxColumns = Math.floor(this.columns / width) || 1;
    if (maxColumns === Infinity) {
      maxColumns = 1;
    }
    let output = "\r\n";
    let lineIndex = 0;
    let whitespace = 0;
    for (let i = 0; i < completions.length; i++) {
      const completion = completions[i];
      if (completion === "" || lineIndex === maxColumns) {
        output += "\r\n";
        lineIndex = 0;
        whitespace = 0;
      } else {
        output += " ".repeat(whitespace);
      }
      if (completion !== "") {
        output += completion;
        whitespace = width - completionsWidth[i];
        lineIndex++;
      } else {
        output += "\r\n";
      }
    }
    if (lineIndex !== 0) {
      output += "\r\n\r\n";
    }
    this._writeToOutput(output);
    this._refreshLine();
  }

  _wordLeft(): void {
    if (this.cursor > 0) {
      // Reverse the string and match a word near the beginning.
      const leading = this.line.slice(0, this.cursor);
      const reversed = Array.from(leading).reverse().join("");
      const match = /^\s*(?:[^\w\s]+|\w+)?/.exec(reversed) as RegExpExecArray;
      this._moveCursor(-match[0].length);
    }
  }

  _wordRight(): void {
    if (this.cursor < this.line.length) {
      const trailing = this.line.slice(this.cursor);
      const match = /^(?:\s+|[^\w\s]+|\w+)\s*/.exec(trailing) as RegExpExecArray;
      this._moveCursor(match[0].length);
    }
  }

  _deleteLeft(): void {
    if (this.cursor > 0 && this.line.length > 0) {
      this._beforeEdit(this.line, this.cursor);
      const charSize = charLengthLeft(this.line, this.cursor);
      this.line =
        this.line.slice(0, this.cursor - charSize) + this.line.slice(this.cursor, this.line.length);
      this.cursor -= charSize;
      this._refreshLine();
    }
  }

  _deleteRight(): void {
    if (this.cursor < this.line.length) {
      this._beforeEdit(this.line, this.cursor);
      const charSize = charLengthAt(this.line, this.cursor);
      this.line =
        this.line.slice(0, this.cursor) + this.line.slice(this.cursor + charSize, this.line.length);
      this._refreshLine();
    }
  }

  _deleteWordLeft(): void {
    if (this.cursor > 0) {
      this._beforeEdit(this.line, this.cursor);
      let leading = this.line.slice(0, this.cursor);
      const reversed = Array.from(leading).reverse().join("");
      const match = /^\s*(?:[^\w\s]+|\w+)?/.exec(reversed) as RegExpExecArray;
      leading = leading.slice(0, leading.length - match[0].length);
      this.line = leading + this.line.slice(this.cursor, this.line.length);
      this.cursor = leading.length;
      this._refreshLine();
    }
  }

  _deleteWordRight(): void {
    if (this.cursor < this.line.length) {
      this._beforeEdit(this.line, this.cursor);
      const trailing = this.line.slice(this.cursor);
      const match = /^(?:\s+|\W+|\w+)\s*/.exec(trailing) as RegExpExecArray;
      this.line = this.line.slice(0, this.cursor) + trailing.slice(match[0].length);
      this._refreshLine();
    }
  }

  _deleteLineLeft(): void {
    this._beforeEdit(this.line, this.cursor);
    this.line = this.line.slice(this.cursor);
    this.cursor = 0;
    this._refreshLine();
  }

  _deleteLineRight(): void {
    this._beforeEdit(this.line, this.cursor);
    this.line = this.line.slice(0, this.cursor);
    this._refreshLine();
  }

  /** Moves past the current line and clears it, without emitting it. */
  clearLine(): void {
    this._moveCursor(+Infinity);
    this._writeToOutput("\r\n");
    this.line = "";
    this.cursor = 0;
    this.prevRows = 0;
  }

  _line(): void {
    const line = this._addHistory();
    this[kUndoStack] = [];
    this[kRedoStack] = [];
    this.clearLine();
    this._onLine(line);
  }

  _beforeEdit(oldText: string, oldCursor: number): void {
    this._pushToUndoStack(oldText, oldCursor);
  }

  _pushToUndoStack(text: string, cursor: number): void {
    if (this[kUndoStack].push({ text, cursor }) > kMaxUndoRedoStackSize) {
      this[kUndoStack].shift();
    }
  }

  _undo(): void {
    if (this[kUndoStack].length <= 0) {
      return;
    }
    this[kRedoStack].push({ text: this.line, cursor: this.cursor });
    const entry = this[kUndoStack].pop() as UndoEntry;
    this.line = entry.text;
    this.cursor = entry.cursor;
    this._refreshLine();
  }

  _redo(): void {
    if (this[kRedoStack].length <= 0) {
      return;
    }
    this[kUndoStack].push({ text: this.line, cursor: this.cursor });
    const entry = this[kRedoStack].pop() as UndoEntry;
    this.line = entry.text;
    this.cursor = entry.cursor;
    this._refreshLine();
  }

  _historyNext(): void {
    if (this.historyIndex >= 0) {
      this._beforeEdit(this.line, this.cursor);
      const search = this[kSubstringSearch] || "";
      let index = this.historyIndex - 1;
      while (
        index >= 0 &&
        (!this.history[index].startsWith(search) || this.line === this.history[index])
      ) {
        index--;
      }
      this.line = index === -1 ? search : this.history[index];
      this.historyIndex = index;
      this.cursor = this.line.length;
      this._refreshLine();
    }
  }

  _historyPrev(): void {
    if (this.historyIndex < this.history.length && this.history.length) {
      this._beforeEdit(this.line, this.cursor);
      const search = this[kSubstringSearch] || "";
      let index = this.historyIndex + 1;
      while (
        index < this.history.length &&
        (!this.history[index].startsWith(search) || this.line === this.history[index])
      ) {
        index++;
      }
      this.line = index === this.history.length ? search : this.history[index];
      this.historyIndex = index;
      this.cursor = this.line.length;
      this._refreshLine();
    }
  }

  /** Where `str` leaves the cursor: rows down and the column, wrapping at `columns`. */
  _getDisplayPos(str: string): { cols: number; rows: number } {
    let offset = 0;
    const col = this.columns;
    let rows = 0;
    str = stripVTControlCharacters(str);
    for (const char of str) {
      if (char === "\n") {
        // Rows must be incremented by 1 even if offset = 0 or col = +Infinity.
        rows += Math.ceil(offset / col) || 1;
        offset = 0;
        continue;
      }
      // Tabs must be aligned by an offset of the tab size.
      if (char === "\t") {
        offset += this.tabSize - (offset % this.tabSize);
        continue;
      }
      const width = getStringWidth(char, false);
      if (width === 0 || width === 1) {
        offset += width;
      } else {
        // width === 2
        if ((offset + 1) % col === 0) {
          offset++;
        }
        offset += 2;
      }
    }
    const cols = offset % col;
    rows += (offset - cols) / col;
    return { cols, rows };
  }

  /** The cursor's row and column relative to the start of the prompt. */
  getCursorPos(): { cols: number; rows: number } {
    return this._getDisplayPos(this._prompt + this.line.slice(0, this.cursor));
  }

  _getCursorPos(): { cols: number; rows: number } {
    return this.getCursorPos();
  }

  _moveCursor(dx: number): void {
    if (dx === 0) {
      return;
    }
    const oldPos = this.getCursorPos();
    this.cursor += dx;
    if (this.cursor < 0) {
      this.cursor = 0;
    } else if (this.cursor > this.line.length) {
      this.cursor = this.line.length;
    }
    const newPos = this.getCursorPos();
    if (oldPos.rows === newPos.rows) {
      moveCursor(this.output, newPos.cols - oldPos.cols, 0);
    } else {
      this._refreshLine();
    }
  }

  /** Handles one keypress in terminal mode. */
  _ttyWrite(s: string | undefined, key?: Partial<Key>): void {
    const previousKey = this[kPreviousKey];
    key = key || {};
    this[kPreviousKey] = key;

    // Activate or deactivate substring search.
    if ((key.name === "up" || key.name === "down") && !key.ctrl && !key.meta && !key.shift) {
      if (this[kSubstringSearch] === null) {
        this[kSubstringSearch] = this.line.slice(0, this.cursor);
      }
    } else if (this[kSubstringSearch] !== null) {
      this[kSubstringSearch] = null;
      // Reset the index in case there's no match.
      if (this.history.length === this.historyIndex) {
        this.historyIndex = -1;
      }
    }

    // Undo & redo
    if (typeof key.sequence === "string") {
      switch (key.sequence.codePointAt(0)) {
        case 0x1f:
          this._undo();
          return;
        case 0x1e:
          this._redo();
          return;
        default:
          break;
      }
    }

    // Ignore the escape key.
    if (key.name === "escape") {
      return;
    }

    if (key.ctrl && key.shift) {
      switch (key.name) {
        case "backspace":
          this._deleteLineLeft();
          break;
        case "delete":
          this._deleteLineRight();
          break;
      }
    } else if (key.ctrl) {
      switch (key.name) {
        case "c":
          if (this.listenerCount("SIGINT") > 0) {
            this.emit("SIGINT");
          } else {
            this.close();
          }
          break;
        case "h": // delete left
          this._deleteLeft();
          break;
        case "d": // delete right or EOF
          if (this.cursor === 0 && this.line.length === 0) {
            this.close();
          } else if (this.cursor < this.line.length) {
            this._deleteRight();
          }
          break;
        case "u": // delete from the cursor to the start of the line
          this._deleteLineLeft();
          break;
        case "k": // delete from the cursor to the end of the line
          this._deleteLineRight();
          break;
        case "a": // start of the line
          this._moveCursor(-Infinity);
          break;
        case "e": // end of the line
          this._moveCursor(+Infinity);
          break;
        case "b": // back one character
          this._moveCursor(-charLengthLeft(this.line, this.cursor));
          break;
        case "f": // forward one character
          this._moveCursor(+charLengthAt(this.line, this.cursor));
          break;
        case "l": // clear the whole screen
          cursorTo(this.output, 0, 0);
          clearScreenDown(this.output);
          this._refreshLine();
          break;
        case "n": // next history item
          this._historyNext();
          break;
        case "p": // previous history item
          this._historyPrev();
          break;
        case "z":
          // Without a listener Node suspends the process; a browser has no job
          // control, so the key is ignored.
          if (this.listenerCount("SIGTSTP") > 0) {
            this.emit("SIGTSTP");
          }
          break;
        case "w": // delete backwards to a word boundary
        case "backspace":
          this._deleteWordLeft();
          break;
        case "delete": // delete forward to a word boundary
          this._deleteWordRight();
          break;
        case "left":
          this._wordLeft();
          break;
        case "right":
          this._wordRight();
          break;
      }
    } else if (key.meta) {
      switch (key.name) {
        case "b": // backward word
          this._wordLeft();
          break;
        case "f": // forward word
          this._wordRight();
          break;
        case "d": // delete forward word
        case "delete":
          this._deleteWordRight();
          break;
        case "backspace": // delete backwards to a word boundary
          this._deleteWordLeft();
          break;
      }
    } else {
      // \r bookkeeping is only relevant if a \n comes right after.
      if (this[kSawReturnAt] && key.name !== "enter") {
        this[kSawReturnAt] = 0;
      }
      switch (key.name) {
        case "return":
          this[kSawReturnAt] = Date.now();
          this._line();
          break;
        case "enter":
          // When the key interval > crlfDelay
          if (this[kSawReturnAt] === 0 || Date.now() - this[kSawReturnAt] > this.crlfDelay) {
            this._line();
          }
          this[kSawReturnAt] = 0;
          break;
        case "backspace":
          this._deleteLeft();
          break;
        case "delete":
          this._deleteRight();
          break;
        case "left":
          this._moveCursor(-charLengthLeft(this.line, this.cursor));
          break;
        case "right":
          this._moveCursor(+charLengthAt(this.line, this.cursor));
          break;
        case "home":
          this._moveCursor(-Infinity);
          break;
        case "end":
          this._moveCursor(+Infinity);
          break;
        case "up":
          this._historyPrev();
          break;
        case "down":
          this._historyNext();
          break;
        case "tab":
          // If tab completion is enabled, do that...
          if (typeof this.completer === "function" && this.isCompletionEnabled) {
            const lastKeypressWasTab = previousKey !== null && previousKey.name === "tab";
            void this._tabComplete(lastKeypressWasTab);
          } else {
            this._insertTyped(s);
          }
          break;
        default:
          this._insertTyped(s);
      }
    }
  }

  /** Inserts typed text, ending a line at each line break in it. */
  _insertTyped(s: string | undefined): void {
    if (typeof s === "string" && s) {
      lineEnding.lastIndex = 0;
      let nextMatch: RegExpExecArray | null;
      let lastIndex = 0;
      while ((nextMatch = lineEnding.exec(s)) !== null) {
        this._insertString(s.slice(lastIndex, nextMatch.index));
        ({ lastIndex } = lineEnding);
        this._line();
        // Restore lastIndex, as `_line` may have used the regexp.
        lineEnding.lastIndex = lastIndex;
      }
      // The last line, when it does not end in a newline.
      this._insertString(s.slice(lastIndex));
    }
  }

  /** Yields each line; ends at `close`. */
  [Symbol.asyncIterator](): AsyncIterableIterator<string> {
    if (this[kLineIterator] === undefined) {
      this[kLineIterator] = createLineIterator(this);
    }
    return this[kLineIterator];
  }

  [kDispose](): void {
    this.close();
  }
}

async function callCompleter(completer: Completer, line: string): Promise<CompleterResult> {
  if (completer.length === 2) {
    return new Promise((resolve, reject) => {
      (completer as (l: string, cb: (e: Error | null, r: CompleterResult) => void) => void)(
        line,
        (error, result) => (error ? reject(error) : resolve(result)),
      );
    });
  }
  return (completer as (l: string) => CompleterResult | Promise<CompleterResult>)(line);
}

/**
 * `events.on(rl, "line", { close: ["close"], highWaterMark: 1024 })` with each
 * value the line itself: buffers lines, pauses the interface when 1024 wait.
 */
function createLineIterator(rl: InterfaceConstructor): AsyncIterableIterator<string> {
  const highWaterMark = 1024;
  const queue: string[] = [];
  const waiting: { resolve(r: IteratorResult<string>): void; reject(e: unknown): void }[] = [];
  let finished = false;
  let error: unknown = null;
  let pausedByUs = false;

  const onLine = (line: string) => {
    const next = waiting.shift();
    if (next) {
      next.resolve({ value: line, done: false });
      return;
    }
    queue.push(line);
    if (queue.length >= highWaterMark && !pausedByUs) {
      pausedByUs = true;
      rl.pause();
    }
  };
  const onClose = () => {
    finish();
  };
  const onError = (caught: unknown) => {
    const next = waiting.shift();
    if (next) {
      next.reject(caught);
    } else {
      error = caught;
    }
    finish();
  };
  function finish(): void {
    if (finished) {
      return;
    }
    finished = true;
    rl.removeListener("line", onLine);
    rl.removeListener("close", onClose);
    rl.removeListener("error", onError);
    for (const next of waiting.splice(0)) {
      next.resolve({ value: undefined, done: true });
    }
  }
  rl.on("line", onLine);
  rl.on("close", onClose);
  rl.on("error", onError);

  const iterator: AsyncIterableIterator<string> = {
    next() {
      if (queue.length > 0) {
        const value = queue.shift() as string;
        if (pausedByUs && queue.length <= 1) {
          pausedByUs = false;
          rl.resume();
        }
        return Promise.resolve({ value, done: false });
      }
      if (error !== null) {
        const caught = error;
        error = null;
        return Promise.reject(caught);
      }
      if (finished) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    return() {
      queue.length = 0;
      finish();
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(caught: unknown) {
      queue.length = 0;
      finish();
      return Promise.reject(caught);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return iterator;
}

/** Sets up `self` as Node's InterfaceConstructor does. */
function initInterface(
  self: InterfaceConstructor,
  input: unknown,
  output: unknown,
  completer: unknown,
  terminal: unknown,
): void {
  self[kSawReturnAt] = 0;
  self.isCompletionEnabled = true;
  self[kSawKeyPress] = false;
  self[kPreviousKey] = null;
  self.escapeCodeTimeout = ESCAPE_CODE_TIMEOUT;
  self.tabSize = 8;
  self.closed = false;
  self.paused = false;
  self.prevRows = 0;
  self[kLineBuffer] = null;
  self[kQuestionCallback] = null;
  self[kOldPrompt] = "";
  self[kLineIterator] = undefined;

  let history: unknown;
  let historySize: unknown;
  let removeHistoryDuplicates = false;
  let crlfDelay: unknown;
  let prompt = "> ";
  let signal: AbortSignal | undefined;

  const options = input as InterfaceOptions | undefined;
  if (options?.input) {
    // An options object was given.
    output = options.output;
    completer = options.completer;
    terminal = options.terminal;
    history = options.history;
    historySize = options.historySize;
    signal = options.signal;
    if (options.tabSize !== undefined) {
      validateInteger(options.tabSize, "tabSize", 1, 4294967295);
      self.tabSize = options.tabSize;
    }
    removeHistoryDuplicates = !!options.removeHistoryDuplicates;
    if (options.prompt !== undefined) {
      prompt = options.prompt;
    }
    if (options.escapeCodeTimeout !== undefined) {
      if (Number.isFinite(options.escapeCodeTimeout)) {
        self.escapeCodeTimeout = options.escapeCodeTimeout;
      } else {
        throw invalidArgValue("input.escapeCodeTimeout", self.escapeCodeTimeout);
      }
    }
    if (signal) {
      validateAbortSignal(signal, "options.signal");
    }
    crlfDelay = options.crlfDelay;
    input = options.input;
  }

  if (completer !== undefined && typeof completer !== "function") {
    throw invalidArgValue("completer", completer);
  }
  if (history === undefined) {
    history = [];
  } else if (!Array.isArray(history)) {
    throw invalidArgType("history", "Array", history);
  }
  if (historySize === undefined) {
    historySize = kHistorySize;
  }
  if (typeof historySize !== "number" || Number.isNaN(historySize) || historySize < 0) {
    const error = invalidArgValue("historySize", historySize);
    throw makeNodeError("ERR_INVALID_ARG_VALUE", error.message, RangeError);
  }
  // Backwards compatibility: check the output's isTTY when `terminal` was not given.
  if (terminal === undefined && !(output === null || output === undefined)) {
    terminal = !!(output as OutputLike).isTTY;
  }

  self.line = "";
  self[kSubstringSearch] = null;
  self.output = output as OutputLike | null | undefined;
  self.input = input as InputLike;
  self[kUndoStack] = [];
  self[kRedoStack] = [];
  self.history = history as string[];
  self.historySize = historySize;
  self.removeHistoryDuplicates = removeHistoryDuplicates;
  self.crlfDelay = crlfDelay ? Math.max(kMincrlfDelay, crlfDelay as number) : kMincrlfDelay;
  self.completer = completer as Completer | undefined;
  self.setPrompt(prompt);
  self.terminal = !!terminal;

  const inputStream = self.input;
  const onError = (error: unknown) => {
    self.emit("error", error);
  };
  const onData = (data: string | Uint8Array) => {
    self._normalWrite(data);
  };
  const onEnd = () => {
    const buffered = self[kLineBuffer];
    if (typeof buffered === "string" && buffered.length > 0) {
      self.emit("line", buffered);
    }
    self.close();
  };
  const onTermEnd = () => {
    if (typeof self.line === "string" && self.line.length > 0) {
      self.emit("line", self.line);
    }
    self.close();
  };
  const onKeypress = (s: string | undefined, key: Key | undefined) => {
    self._ttyWrite(s, key);
    if (key && key.sequence) {
      // Half of a surrogate pair: refresh so the character shows properly.
      const ch = key.sequence.codePointAt(0) as number;
      if (ch >= 0xd800 && ch <= 0xdfff) {
        self._refreshLine();
      }
    }
  };
  const onResize = () => {
    self._refreshLine();
  };

  inputStream.on("error", onError);

  if (!self.terminal) {
    self[kDecoder] = new StringDecoder("utf8");
    inputStream.on("data", onData);
    inputStream.on("end", onEnd);
    self.once("close", () => {
      inputStream.removeListener("data", onData);
      inputStream.removeListener("error", onError);
      inputStream.removeListener("end", onEnd);
    });
  } else {
    emitKeypressEvents(inputStream, self);
    inputStream.on("keypress", onKeypress);
    inputStream.on("end", onTermEnd);
    self._setRawMode(true);
    self.terminal = true;
    self.cursor = 0;
    self.historyIndex = -1;
    const out = self.output;
    if (out !== null && out !== undefined && typeof out.on === "function") {
      out.on("resize", onResize);
    }
    self.once("close", () => {
      inputStream.removeListener("keypress", onKeypress);
      inputStream.removeListener("error", onError);
      inputStream.removeListener("end", onTermEnd);
      if (out !== null && out !== undefined && typeof out.removeListener === "function") {
        out.removeListener("resize", onResize);
      }
    });
  }

  if (signal) {
    const onAborted = () => self.close();
    if (signal.aborted) {
      queueMicrotask(onAborted);
    } else {
      const disposable = addAbortListener(signal, onAborted);
      self.once("close", () => {
        (disposable as unknown as Record<symbol, () => void>)[kDispose]();
      });
    }
  }

  inputStream.resume?.();
}

// ---------------------------------------------------------------------------
// lib/readline.js: the callback Interface

/** `readline.Interface`: callable with or without `new`, extendable by classes. */
export interface Interface extends InterfaceConstructor {
  question(query: string, cb: (answer: string) => void): void;
  question(query: string, options: { signal?: AbortSignal }, cb: (answer: string) => void): void;
}

/** The legacy `readline.Interface` constructor function. */
export interface InterfaceFunction {
  new (input: unknown, output?: unknown, completer?: unknown, terminal?: unknown): Interface;
  (input: unknown, output?: unknown, completer?: unknown, terminal?: unknown): Interface;
  prototype: Interface;
}

/** `readline.Interface`. */
export const Interface = function Interface(
  this: unknown,
  input: unknown,
  output?: unknown,
  completer?: unknown,
  terminal?: unknown,
): Interface | undefined {
  if (!(this instanceof Interface)) {
    return new (Interface as InterfaceFunction)(input, output, completer, terminal);
  }
  (EventEmitter as unknown as (this: unknown) => void).call(this);
  initInterface(this as InterfaceConstructor, input, output, completer, terminal);
  return undefined;
} as unknown as InterfaceFunction;

Interface.prototype = Object.create(InterfaceConstructor.prototype, {
  constructor: { value: Interface, writable: true, configurable: true },
}) as Interface;
Object.setPrototypeOf(Interface, InterfaceConstructor);

function legacyQuestion(
  this: InterfaceConstructor,
  query: string,
  options: unknown,
  cb?: unknown,
): void {
  cb = typeof options === "function" ? options : cb;
  const opts =
    options === null || typeof options !== "object" ? {} : (options as { signal?: AbortSignal });
  if (opts.signal) {
    const signal = opts.signal;
    validateAbortSignal(signal, "options.signal");
    if (signal.aborted) {
      return;
    }
    const onAbort = () => {
      this._questionCancel();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const originalCb = cb;
    cb =
      typeof originalCb === "function"
        ? (answer: string) => {
            cleanup();
            return (originalCb as (a: string) => unknown)(answer);
          }
        : cleanup;
  }
  if (typeof cb === "function") {
    this._question(query, cb as (answer: string) => void);
  }
}

/** `util.promisify(rl.question)`: resolves with the answer, rejects with AbortError. */
function questionCustom(
  this: InterfaceConstructor,
  query: string,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  return questionPromise(this, query, options);
}

function questionPromise(
  self: InterfaceConstructor,
  query: string,
  options: { signal?: AbortSignal } | null | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let cb: (answer: string) => void = resolve;
    const signal = options?.signal;
    if (signal) {
      validateAbortSignal(signal, "options.signal");
      if (signal.aborted) {
        reject(new AbortError(undefined, { cause: signal.reason }));
        return;
      }
      const onAbort = () => {
        self._questionCancel();
        reject(new AbortError(undefined, { cause: signal.reason }));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      cb = (answer) => {
        signal.removeEventListener("abort", onAbort);
        resolve(answer);
      };
    }
    self._question(query, cb);
  });
}

Object.defineProperty(legacyQuestion, Symbol.for("nodejs.util.promisify.custom"), {
  value: questionCustom,
  configurable: true,
  writable: true,
});
Object.defineProperty(Interface.prototype, "question", {
  value: legacyQuestion,
  writable: true,
  configurable: true,
});

/** `readline.createInterface(options)` / `(input, output, completer, terminal)`. */
export function createInterface(
  input: unknown,
  output?: unknown,
  completer?: unknown,
  terminal?: unknown,
): Interface {
  return new Interface(input, output, completer, terminal);
}

// ---------------------------------------------------------------------------
// lib/internal/readline/promises.js and lib/readline/promises.js

/** `readline/promises` `Interface`: `question` returns a promise. */
export class PromisesInterface extends InterfaceConstructor {
  /** Asks `query` and resolves with the answer. */
  question(query: string, options?: { signal?: AbortSignal }): Promise<string> {
    return questionPromise(this, query, options);
  }
}
Object.defineProperty(PromisesInterface, "name", { value: "Interface" });

function isWritableStream(stream: unknown): boolean {
  return (
    typeof stream === "object" &&
    stream !== null &&
    typeof (stream as { write?: unknown }).write === "function" &&
    typeof (stream as { on?: unknown }).on === "function"
  );
}

/** `readline/promises` `Readline`: queues cursor actions and writes them on `commit()`. */
export class Readline {
  #autoCommit = false;
  #stream: WritableLike;
  #todo: string[] = [];

  constructor(stream: unknown, options?: { autoCommit?: boolean }) {
    if (!isWritableStream(stream)) {
      throw invalidArgType("stream", "Writable", stream);
    }
    this.#stream = stream as WritableLike;
    if (options?.autoCommit != null) {
      validateBoolean(options.autoCommit, "options.autoCommit");
      this.#autoCommit = options.autoCommit;
    }
  }

  #queue(data: string): void {
    if (this.#autoCommit) {
      queueMicrotask(() => this.#stream.write(data));
    } else {
      this.#todo.push(data);
    }
  }

  /** Moves the cursor to column `x` (and row `y`). */
  cursorTo(x: number, y?: number): this {
    validateInteger(x, "x");
    if (y != null) {
      validateInteger(y, "y");
    }
    this.#queue(y == null ? `\x1b[${x + 1}G` : `\x1b[${y + 1};${x + 1}H`);
    return this;
  }

  /** Moves the cursor by `dx` columns and `dy` rows. */
  moveCursor(dx: number, dy: number): this {
    if (dx || dy) {
      validateInteger(dx, "dx");
      validateInteger(dy, "dy");
      this.#queue(moveData(dx, dy));
    }
    return this;
  }

  /** Clears the line left of the cursor (-1), right of it (1) or all of it (0). */
  clearLine(dir: number): this {
    validateInteger(dir, "dir", -1, 1);
    this.#queue(dir < 0 ? kClearToLineBeginning : dir > 0 ? kClearToLineEnd : kClearLine);
    return this;
  }

  /** Clears from the cursor down. */
  clearScreenDown(): this {
    this.#queue(kClearScreenDown);
    return this;
  }

  /** Writes the queued actions. */
  commit(): Promise<void> {
    return new Promise((resolve) => {
      this.#stream.write(this.#todo.join(""), () => resolve());
      this.#todo = [];
    });
  }

  /** Drops the queued actions. */
  rollback(): this {
    this.#todo = [];
    return this;
  }
}

/** `readline/promises` `createInterface`. */
export function createPromisesInterface(
  input: unknown,
  output?: unknown,
  completer?: unknown,
  terminal?: unknown,
): PromisesInterface {
  return new PromisesInterface(input, output, completer, terminal);
}

/** `require("readline/promises")`. */
export const promises = {
  Interface: PromisesInterface,
  Readline,
  createInterface: createPromisesInterface,
};

/** `require("readline")`. */
const readline = {
  Interface,
  clearLine,
  clearScreenDown,
  createInterface,
  cursorTo,
  emitKeypressEvents,
  moveCursor,
  promises,
};

export default readline;
