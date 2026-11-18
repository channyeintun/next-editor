// Node's `console`: formats with `util.format` and writes to the process's
// stdout and stderr streams, so a program's output reaches its terminal or pipe.
// As Node's, a console keeps a failed write to itself: console.log to a pipe
// whose reader has gone stays silent instead of ending the program with EPIPE.
import { invalidArgType, makeNodeError } from "./internalErrors";
import { getStringWidth } from "./stringWidth";
import util from "./util";

interface OutputStream {
  write(chunk: string, callback?: (error?: Error | null) => void): unknown;
  isTTY?: boolean;
  getColorDepth?: () => number;
}

/** A stream that emits 'error', as every Node stream does. */
interface EmitterStream extends OutputStream {
  listenerCount(event: string): number;
  once(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
  _writableState?: { errorEmitted?: boolean };
}

/** A stream, or the function that gives it when it is first written to. */
type StreamSource = OutputStream | (() => OutputStream);

type WriteErrorHandler = (error?: Error | null) => void;

export interface ConsoleOptions {
  stdout: OutputStream;
  stderr?: OutputStream;
  ignoreErrors?: boolean;
  colorMode?: boolean | "auto";
  inspectOptions?: Record<string, unknown>;
  groupIndentation?: number;
}

/** What a program gave the constructor, before its streams are checked. */
interface UncheckedOptions extends Omit<ConsoleOptions, "stdout" | "stderr"> {
  stdout?: unknown;
  stderr?: unknown;
}

function isStream(value: unknown): value is OutputStream {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as OutputStream).write === "function"
  );
}

function notWritable(name: "stdout" | "stderr"): Error {
  return makeNodeError(
    "ERR_CONSOLE_WRITABLE_STREAM",
    `Console expects a writable stream instance for ${name}`,
    TypeError,
  );
}

function isEmitter(stream: OutputStream): stream is EmitterStream {
  const candidate = stream as Partial<EmitterStream>;
  return (
    typeof candidate.listenerCount === "function" &&
    typeof candidate.once === "function" &&
    typeof candidate.removeListener === "function"
  );
}

/** The one 'error' listener a console adds, and removes by this reference. */
function noop(): void {}

function isStackOverflow(error: unknown): boolean {
  return error instanceof RangeError && /call stack/i.test(error.message);
}

/**
 * Node's createWriteErrorHandler: a write that failed after `write` returned
 * gives its stream a one-time 'error' listener, unless the error was emitted
 * already or the program listens itself. The listener goes with the event, so
 * the program's own writes still see their errors.
 */
function writeErrorHandler(streamOf: () => OutputStream): WriteErrorHandler {
  return (error) => {
    // readable-stream calls back with nothing after a write that worked.
    if (error === null || error === undefined) {
      return;
    }
    const stream = streamOf();
    if (
      isEmitter(stream) &&
      stream._writableState?.errorEmitted !== true &&
      stream.listenerCount("error") === 0
    ) {
      stream.once("error", noop);
    }
  };
}

/** A property of a console as Node defines it: seen by name, not listed. */
const hidden = <T>(value: T): PropertyDescriptor => ({
  value,
  writable: true,
  enumerable: false,
  configurable: true,
});

/**
 * Gives `console` its streams from `stdout` and `stderr` on first use, as
 * Node's global console takes `process.stdout` and `process.stderr`.
 */
function bindStreamsLazily(
  console: Console,
  stdout: () => OutputStream,
  stderr: () => OutputStream,
): void {
  let out: OutputStream | undefined;
  let err: OutputStream | undefined;
  Object.defineProperties(console, {
    _stdout: {
      configurable: true,
      enumerable: false,
      get: () => (out ??= stdout()),
      set(stream: OutputStream) {
        out = stream;
      },
    },
    _stderr: {
      configurable: true,
      enumerable: false,
      get: () => (err ??= stderr()),
      set(stream: OutputStream) {
        err = stream;
      },
    },
  });
}

/** The `console.Console` class. */
export class Console {
  // The members Node's console carries by these names: loggers read
  // `console._stdout`, and a program may assign any of them. Every method
  // reads them at each call. The constructor defines them, not enumerable.
  declare _stdout: OutputStream;
  declare _stderr: OutputStream;
  declare _ignoreErrors: boolean;
  declare _stdoutErrorHandler: WriteErrorHandler;
  declare _stderrErrorHandler: WriteErrorHandler;
  /** When each `console.time` label was started. */
  declare _times: Map<string, number>;
  readonly #colorMode: boolean | "auto";
  readonly #inspectOptions: Record<string, unknown> | undefined;
  readonly #indentation: number;
  #indent = "";
  readonly #counts = new Map<string, number>();

  constructor(
    options?: ConsoleOptions | OutputStream,
    stderr?: OutputStream,
    ignoreErrors?: boolean,
  ) {
    const resolved: UncheckedOptions =
      options === undefined || options === null || isStream(options)
        ? { stdout: options, stderr, ignoreErrors }
        : options;
    const out = resolved.stdout;
    const err = resolved.stderr ?? out;
    if (!isStream(out)) {
      throw notWritable("stdout");
    }
    if (!isStream(err)) {
      throw notWritable("stderr");
    }
    Object.defineProperties(this, {
      _stdout: hidden(out),
      _stderr: hidden(err),
      _ignoreErrors: hidden(resolved.ignoreErrors ?? true),
      _stdoutErrorHandler: hidden(writeErrorHandler(() => this._stdout)),
      _stderrErrorHandler: hidden(writeErrorHandler(() => this._stderr)),
      _times: hidden(new Map<string, number>()),
    });
    this.#colorMode = resolved.colorMode ?? "auto";
    this.#inspectOptions = resolved.inspectOptions;
    this.#indentation = resolved.groupIndentation ?? 2;

    // Console methods are passed around unbound (`const { log } = console`).
    for (const name of Object.getOwnPropertyNames(Console.prototype)) {
      const method = (this as unknown as Record<string, unknown>)[name];
      if (name !== "constructor" && typeof method === "function") {
        (this as unknown as Record<string, unknown>)[name] = method.bind(this);
      }
    }
  }

  #useColors(stream: OutputStream): boolean {
    if (this.#colorMode !== "auto") {
      return this.#colorMode;
    }
    return stream.isTTY === true && (stream.getColorDepth?.() ?? 1) > 2;
  }

  #inspectOptionsFor(stream: OutputStream): Record<string, unknown> {
    return { ...this.#inspectOptions, colors: this.#useColors(stream) };
  }

  #write(target: "stdout" | "stderr", args: unknown[]): void {
    const stream = target === "stdout" ? this._stdout : this._stderr;
    this.#writeText(target, util.formatWithOptions(this.#inspectOptionsFor(stream), ...args));
  }

  /**
   * Writes `text` and a newline, every line indented by the current group, as
   * Node's Console[kWriteToConsole]: unless `ignoreErrors` is false, an error
   * the write throws is dropped, and one it reports is given a one-time
   * listener (see `writeErrorHandler`), so it never reaches the program.
   */
  #writeText(target: "stdout" | "stderr", text: string): void {
    if (this.#indent) {
      text = this.#indent + text.replace(/\n/g, `\n${this.#indent}`);
    }
    text += "\n";
    const stream = target === "stdout" ? this._stdout : this._stderr;
    if (!this._ignoreErrors) {
      stream.write(text);
      return;
    }
    const emitter = isEmitter(stream);
    try {
      // For an error the write emits before it returns.
      if (emitter && stream.listenerCount("error") === 0) {
        stream.once("error", noop);
      }
      stream.write(text, target === "stdout" ? this._stdoutErrorHandler : this._stderrErrorHandler);
    } catch (error) {
      // A console is for debugging: only running out of stack is let through.
      if (isStackOverflow(error)) {
        throw error;
      }
    } finally {
      if (emitter) {
        stream.removeListener("error", noop);
      }
    }
  }

  log(...args: unknown[]): void {
    this.#write("stdout", args);
  }

  info(...args: unknown[]): void {
    this.#write("stdout", args);
  }

  debug(...args: unknown[]): void {
    this.#write("stdout", args);
  }

  error(...args: unknown[]): void {
    this.#write("stderr", args);
  }

  warn(...args: unknown[]): void {
    this.#write("stderr", args);
  }

  dir(value: unknown, options?: Record<string, unknown>): void {
    this.#writeText(
      "stdout",
      util.inspect(value, {
        customInspect: false,
        ...this.#inspectOptionsFor(this._stdout),
        ...options,
      }),
    );
  }

  dirxml(...args: unknown[]): void {
    this.#write("stdout", args);
  }

  trace(...args: unknown[]): void {
    const error = new Error(util.format(...args));
    error.name = "Trace";
    this.#write("stderr", [error.stack]);
  }

  assert(condition: unknown, ...args: unknown[]): void {
    if (condition) {
      return;
    }
    if (typeof args[0] === "string") {
      args[0] = `Assertion failed: ${args[0]}`;
    } else {
      args.unshift("Assertion failed");
    }
    this.#write("stderr", args);
  }

  clear(): void {
    const stdout = this._stdout;
    if (stdout.isTTY) {
      stdout.write("\x1b[1;1H\x1b[0J");
    }
  }

  count(label = "default"): void {
    const count = (this.#counts.get(label) ?? 0) + 1;
    this.#counts.set(label, count);
    this.#write("stdout", [`${label}: ${count}`]);
  }

  countReset(label = "default"): void {
    this.#counts.delete(label);
  }

  group(...args: unknown[]): void {
    if (args.length > 0) {
      this.#write("stdout", args);
    }
    this.#indent += " ".repeat(this.#indentation);
  }

  groupCollapsed(...args: unknown[]): void {
    this.group(...args);
  }

  groupEnd(): void {
    this.#indent = this.#indent.slice(0, Math.max(0, this.#indent.length - this.#indentation));
  }

  time(label = "default"): void {
    this._times.set(label, performance.now());
  }

  #elapsed(label: string): string | null {
    const start = this._times.get(label);
    if (start === undefined) {
      this.#write("stderr", [`Warning: No such label '${label}' for console.time()`]);
      return null;
    }
    const milliseconds = performance.now() - start;
    return milliseconds >= 1000
      ? `${(milliseconds / 1000).toFixed(3)}s`
      : `${milliseconds.toFixed(3)}ms`;
  }

  timeEnd(label = "default"): void {
    const elapsed = this.#elapsed(label);
    if (elapsed !== null) {
      this._times.delete(label);
      this.#write("stdout", [`${label}: ${elapsed}`]);
    }
  }

  timeLog(label = "default", ...args: unknown[]): void {
    const elapsed = this.#elapsed(label);
    if (elapsed !== null) {
      this.#write("stdout", [`${label}: ${elapsed}`, ...args]);
    }
  }

  /** Node's console.table (lib/internal/console/constructor.js and cli_table.js). */
  table(tabularData: unknown, properties?: string[]): void {
    if (properties !== undefined && !Array.isArray(properties)) {
      throw invalidArgType("properties", "Array", properties);
    }
    if (tabularData === null || typeof tabularData !== "object") {
      this.log(tabularData);
      return;
    }
    const inspectCell = (value: unknown): string => {
      const depth =
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !util.types.isTypedArray(value) &&
        Object.keys(value).length > 2
          ? -1
          : 0;
      return util.inspect(value, {
        depth,
        maxArrayLength: 3,
        breakLength: Infinity,
        ...this.#inspectOptionsFor(this._stdout),
      });
    };
    const indexes = (length: number) => Array.from({ length }, (_, i) => inspectCell(i));
    const final = (head: string[], columns: string[][]) => this.log(renderTable(head, columns));

    if (util.types.isMap(tabularData)) {
      const keys: string[] = [];
      const values: string[] = [];
      for (const [key, value] of tabularData as Map<unknown, unknown>) {
        keys.push(inspectCell(key));
        values.push(inspectCell(value));
      }
      final(["(iteration index)", "Key", "Values"], [indexes(keys.length), keys, values]);
      return;
    }
    if (util.types.isSet(tabularData)) {
      const values = [...(tabularData as Set<unknown>)].map(inspectCell);
      final(["(iteration index)", "Values"], [indexes(values.length), values]);
      return;
    }

    const columns: Record<string, string[]> = Object.create(null);
    let hasPrimitives = false;
    const primitiveValues: string[] = [];
    const indexKeys = Object.keys(tabularData);
    for (let i = 0; i < indexKeys.length; i++) {
      const item = (tabularData as Record<string, unknown>)[indexKeys[i]];
      const primitive = item === null || (typeof item !== "function" && typeof item !== "object");
      if (properties === undefined && primitive) {
        hasPrimitives = true;
        primitiveValues[i] = inspectCell(item);
      } else {
        for (const key of properties ?? Object.keys(item as object)) {
          columns[key] ??= [];
          columns[key][i] =
            (primitive && properties) || !Object.prototype.hasOwnProperty.call(item, key)
              ? ""
              : inspectCell((item as Record<string, unknown>)[key]);
        }
      }
    }
    const head = Object.keys(columns);
    const values = Object.values(columns);
    if (hasPrimitives) {
      head.push("Values");
      values.push(primitiveValues);
    }
    head.unshift("(index)");
    values.unshift(indexKeys);
    final(head, values);
  }
}

/**
 * Node's cli_table: `head` over `columns`, cells left-justified. A cell is as
 * wide as the columns it takes on a terminal: its colour codes take none, a
 * combining mark none, a wide character two.
 */
function renderTable(head: string[], columns: string[][]): string {
  const rows: string[][] = [];
  const widths = head.map((h) => getStringWidth(h));
  const longest = Math.max(...columns.map((column) => column.length));
  for (let i = 0; i < head.length; i++) {
    const column = columns[i];
    for (let j = 0; j < longest; j++) {
      rows[j] ??= [];
      const value = (rows[j][i] = Object.prototype.hasOwnProperty.call(column, j) ? column[j] : "");
      widths[i] = Math.max(widths[i] || 0, getStringWidth(value));
    }
  }
  const renderRow = (row: string[]) =>
    `│ ${row.map((cell, i) => cell + " ".repeat(widths[i] - getStringWidth(cell))).join(" │ ")} │`;
  const divider = widths.map((width) => "─".repeat(width + 2));
  return [
    `┌${divider.join("┬")}┐`,
    renderRow(head),
    `├${divider.join("┼")}┤`,
    ...rows.map(renderRow),
    `└${divider.join("┴")}┘`,
  ].join("\n");
}

/** The global console: a Console with the class itself and the inspector's methods. */
export type GlobalConsole = Console & {
  Console: typeof Console;
  profile(): void;
  profileEnd(): void;
  timeStamp(): void;
};

/**
 * The global console for a process with the given stdout and stderr. Either
 * may be a function that gives the stream: it is called on the first write,
 * as Node's global console binds `process.stdout` and `process.stderr` lazily.
 */
export function createConsole(stdout: StreamSource, stderr: StreamSource): GlobalConsole {
  const pending: OutputStream = { write: () => true };
  const console = new Console({ stdout: pending });
  bindStreamsLazily(
    console,
    typeof stdout === "function" ? stdout : () => stdout,
    typeof stderr === "function" ? stderr : () => stderr,
  );
  // The inspector's methods, which only the global console has: without an
  // inspector they do nothing, as in Node.
  return Object.assign(console, {
    Console,
    profile() {},
    profileEnd() {},
    timeStamp() {},
  });
}
