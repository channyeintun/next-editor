// Node's `console`: formats with `util.format` and writes to the process's
// stdout and stderr streams, so a program's output reaches its terminal or pipe.
import util from "./util";

interface OutputStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
  getColorDepth?: () => number;
}

export interface ConsoleOptions {
  stdout: OutputStream;
  stderr?: OutputStream;
  ignoreErrors?: boolean;
  colorMode?: boolean | "auto";
  inspectOptions?: Record<string, unknown>;
  groupIndentation?: number;
}

function isStream(value: unknown): value is OutputStream {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as OutputStream).write === "function"
  );
}

/** The `console.Console` class. */
export class Console {
  private readonly out: OutputStream;
  private readonly err: OutputStream;
  private readonly colorMode: boolean | "auto";
  private readonly inspectOptions: Record<string, unknown> | undefined;
  private readonly indentation: number;
  private indent = "";
  private readonly counts = new Map<string, number>();
  private readonly timers = new Map<string, number>();

  constructor(options: ConsoleOptions | OutputStream, stderr?: OutputStream) {
    const resolved: ConsoleOptions = isStream(options) ? { stdout: options, stderr } : options;
    this.out = resolved.stdout;
    this.err = resolved.stderr ?? resolved.stdout;
    this.colorMode = resolved.colorMode ?? "auto";
    this.inspectOptions = resolved.inspectOptions;
    this.indentation = resolved.groupIndentation ?? 2;

    // Console methods are passed around unbound (`const { log } = console`).
    for (const name of Object.getOwnPropertyNames(Console.prototype)) {
      const method = (this as unknown as Record<string, unknown>)[name];
      if (name !== "constructor" && typeof method === "function") {
        (this as unknown as Record<string, unknown>)[name] = method.bind(this);
      }
    }
  }

  private useColors(stream: OutputStream): boolean {
    if (this.colorMode !== "auto") {
      return this.colorMode;
    }
    return stream.isTTY === true && (stream.getColorDepth?.() ?? 1) > 2;
  }

  private write(stream: OutputStream, args: unknown[]): void {
    const options = { ...this.inspectOptions, colors: this.useColors(stream) };
    let text = util.formatWithOptions(options, ...args);
    if (this.indent) {
      text = text
        .split("\n")
        .map((line) => this.indent + line)
        .join("\n");
    }
    stream.write(`${text}\n`);
  }

  log(...args: unknown[]): void {
    this.write(this.out, args);
  }

  info(...args: unknown[]): void {
    this.write(this.out, args);
  }

  debug(...args: unknown[]): void {
    this.write(this.out, args);
  }

  error(...args: unknown[]): void {
    this.write(this.err, args);
  }

  warn(...args: unknown[]): void {
    this.write(this.err, args);
  }

  dir(value: unknown, options?: Record<string, unknown>): void {
    this.out.write(
      `${this.indent}${util.inspect(value, { customInspect: false, colors: this.useColors(this.out), ...options })}\n`,
    );
  }

  dirxml(...args: unknown[]): void {
    this.write(this.out, args);
  }

  trace(...args: unknown[]): void {
    const error = new Error(util.format(...args));
    error.name = "Trace";
    this.write(this.err, [error.stack]);
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
    this.write(this.err, args);
  }

  clear(): void {
    if (this.out.isTTY) {
      this.out.write("\x1b[1;1H\x1b[0J");
    }
  }

  count(label = "default"): void {
    const count = (this.counts.get(label) ?? 0) + 1;
    this.counts.set(label, count);
    this.write(this.out, [`${label}: ${count}`]);
  }

  countReset(label = "default"): void {
    this.counts.delete(label);
  }

  group(...args: unknown[]): void {
    if (args.length > 0) {
      this.write(this.out, args);
    }
    this.indent += " ".repeat(this.indentation);
  }

  groupCollapsed(...args: unknown[]): void {
    this.group(...args);
  }

  groupEnd(): void {
    this.indent = this.indent.slice(0, Math.max(0, this.indent.length - this.indentation));
  }

  time(label = "default"): void {
    this.timers.set(label, performance.now());
  }

  private elapsed(label: string): string | null {
    const start = this.timers.get(label);
    if (start === undefined) {
      this.write(this.err, [`Warning: No such label '${label}' for console.time()`]);
      return null;
    }
    const milliseconds = performance.now() - start;
    return milliseconds >= 1000
      ? `${(milliseconds / 1000).toFixed(3)}s`
      : `${milliseconds.toFixed(3)}ms`;
  }

  timeEnd(label = "default"): void {
    const elapsed = this.elapsed(label);
    if (elapsed !== null) {
      this.timers.delete(label);
      this.write(this.out, [`${label}: ${elapsed}`]);
    }
  }

  timeLog(label = "default", ...args: unknown[]): void {
    const elapsed = this.elapsed(label);
    if (elapsed !== null) {
      this.write(this.out, [`${label}: ${elapsed}`, ...args]);
    }
  }

  timeStamp(): void {}

  profile(): void {}

  profileEnd(): void {}

  table(data: unknown, columns?: string[]): void {
    if (data === null || typeof data !== "object") {
      this.write(this.out, [data]);
      return;
    }
    const rows = Object.entries(data as Record<string, unknown>);
    const keys = new Set<string>();
    let hasValues = false;
    for (const [, row] of rows) {
      if (row !== null && typeof row === "object") {
        for (const key of Object.keys(row)) {
          keys.add(key);
        }
      } else {
        hasValues = true;
      }
    }
    const headers = ["(index)", ...(columns ?? [...keys]), ...(hasValues ? ["Values"] : [])];
    const cell = (value: unknown) =>
      value === undefined ? "" : util.inspect(value, { depth: 0, breakLength: Infinity });
    const lines = rows.map(([index, row]) => {
      const isObject = row !== null && typeof row === "object";
      return headers.map((header, position) => {
        if (position === 0) {
          return index;
        }
        if (header === "Values" && hasValues && position === headers.length - 1) {
          return isObject ? "" : cell(row);
        }
        return isObject ? cell((row as Record<string, unknown>)[header]) : "";
      });
    });
    const widths = headers.map((header, position) =>
      Math.max(header.length, ...lines.map((line) => line[position].length)),
    );
    const rule = (left: string, middle: string, right: string) =>
      left + widths.map((width) => "─".repeat(width + 2)).join(middle) + right;
    const format = (line: string[]) =>
      `│${line.map((text, position) => ` ${text.padEnd(widths[position])} `).join("│")}│`;
    this.out.write(
      `${[rule("┌", "┬", "┐"), format(headers), rule("├", "┼", "┤"), ...lines.map(format), rule("└", "┴", "┘")].join("\n")}\n`,
    );
  }
}

/** The global console for a process with the given stdout and stderr. */
export function createConsole(
  stdout: OutputStream,
  stderr: OutputStream,
): Console & { Console: typeof Console } {
  const console = new Console({ stdout, stderr }) as Console & { Console: typeof Console };
  console.Console = Console;
  return console;
}
