// A terminal between a running program and the page, in shared memory.
//
// A Python program runs inside one WebAssembly call that returns only when the
// program does. Until then its worker takes no message, so the page cannot
// hand it a typed line that way; and while the program computes or sleeps
// nothing in the worker runs that could send its output at a steady pace. So
// the two sides share one block of memory instead:
//
// - the worker copies the program's output into it as it is written, and the
//   page reads from it on its own clock, however busy the program is;
// - `input()` parks the worker on a cell of it (`Atomics.wait`) until the page
//   has written the line and woken it.
//
// Sharing memory with a worker needs a cross-origin isolated page. Where the
// page is not, there is no terminal: output arrives with the result, and
// `input()` meets the end of its input (interpreter.ts says so in a hint).

import { PLAYGROUND_INPUT_LINE_MAX_LENGTH } from "../playgroundLanguage";
import { PYTHON_MAX_OUTPUT_BYTES, type PythonRunTerminal } from "./interpreter";

/** The cells at the head of the memory, four bytes each. */
const STATE = 0;
const OUTPUT_LENGTH = 1;
const INPUT_LENGTH = 2;
const HEADER_BYTES = 16;

/** STATE: the program is running, or parked until the page answers. */
const RUNNING = 0;
const WAITING = 1;

/** INPUT_LENGTH for an answer that is no line: the end of the input. */
const END_OF_INPUT = -1;

const OUTPUT_OFFSET = HEADER_BYTES;
/** A typed line as UTF-8: at most three bytes for each UTF-16 unit. */
const INPUT_BYTES = PLAYGROUND_INPUT_LINE_MAX_LENGTH * 3;
const INPUT_OFFSET = OUTPUT_OFFSET + PYTHON_MAX_OUTPUT_BYTES;

function views(memory: SharedArrayBuffer) {
  return {
    cells: new Int32Array(memory, 0, HEADER_BYTES / 4),
    output: new Uint8Array(memory, OUTPUT_OFFSET, PYTHON_MAX_OUTPUT_BYTES),
    input: new Uint8Array(memory, INPUT_OFFSET, INPUT_BYTES),
  };
}

/**
 * The program's end of the terminal, for the thread the interpreter runs on.
 * `readLine` blocks that thread, which is why it is a worker's.
 */
export function programPythonTerminal(memory: SharedArrayBuffer): PythonRunTerminal {
  const { cells, output, input } = views(memory);
  let written = 0;
  return {
    write(bytes) {
      // The interpreter hands over what its output budget keeps, which is the
      // size of this region; the bound is here so a mistake there cannot write
      // into the line next to it.
      const kept = bytes.subarray(0, output.length - written);
      output.set(kept, written);
      written += kept.length;
      Atomics.store(cells, OUTPUT_LENGTH, written);
    },
    readLine() {
      Atomics.store(cells, STATE, WAITING);
      // A wake that finds the state unchanged was not the answer: wait again.
      while (Atomics.load(cells, STATE) === WAITING) {
        Atomics.wait(cells, STATE, WAITING);
      }
      const length = Atomics.load(cells, INPUT_LENGTH);
      // Copied out before decoding: a decoder does not take shared memory.
      return length === END_OF_INPUT ? null : new TextDecoder().decode(input.slice(0, length));
    },
  };
}

/** The page's end of the terminal. */
export interface PythonTerminalView {
  /**
   * Whether the program is parked at `input()`. Read it before `output`: the
   * program prints its prompt and then waits, so output read after a true
   * answer holds everything printed before the wait.
   */
  isWaiting(): boolean;
  /** Everything the program has printed so far, typed lines included. */
  output(): string;
  /** Hands the waiting program its line, or null for the end of its input. */
  answer(line: string | null): void;
}

/** One run's terminal as the page holds it: the memory to hand the worker, and its own end. */
export interface PythonTerminalLink {
  memory: SharedArrayBuffer;
  view: PythonTerminalView;
}

/**
 * A terminal for one run, or null where a page cannot share memory with a
 * worker. A browser that is not cross-origin isolated may still have the
 * constructor, and then refuses to post what it makes.
 */
export function openPythonTerminal(): PythonTerminalLink | null {
  if (typeof SharedArrayBuffer === "undefined" || globalThis.crossOriginIsolated === false) {
    return null;
  }
  const memory = new SharedArrayBuffer(INPUT_OFFSET + INPUT_BYTES);
  return { memory, view: pagePythonTerminal(memory) };
}

function pagePythonTerminal(memory: SharedArrayBuffer): PythonTerminalView {
  const { cells, output, input } = views(memory);
  // A streaming decoder: a read can end between the bytes of one character.
  const decoder = new TextDecoder();
  let text = "";
  let read = 0;
  return {
    isWaiting: () => Atomics.load(cells, STATE) === WAITING,
    output() {
      const length = Atomics.load(cells, OUTPUT_LENGTH);
      if (length > read) {
        text += decoder.decode(output.slice(read, length), { stream: true });
        read = length;
      }
      return text;
    },
    answer(line) {
      if (line === null) {
        Atomics.store(cells, INPUT_LENGTH, END_OF_INPUT);
      } else {
        // Encoded into memory of its own first: an encoder does not write to
        // shared memory either. It stops at the last whole character that fits.
        const bytes = new Uint8Array(INPUT_BYTES);
        const { written } = new TextEncoder().encodeInto(line, bytes);
        input.set(bytes.subarray(0, written));
        Atomics.store(cells, INPUT_LENGTH, written);
      }
      Atomics.store(cells, STATE, RUNNING);
      Atomics.notify(cells, STATE);
    },
  };
}
