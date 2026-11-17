// Node's `console`: formats with `util.format` and writes to the process's
// stdout and stderr streams, so a program's output reaches its terminal or pipe.
import { invalidArgType } from "./internalErrors";
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

  private inspectOptionsFor(stream: OutputStream): Record<string, unknown> {
    return { ...this.inspectOptions, colors: this.useColors(stream) };
  }

  private write(stream: OutputStream, args: unknown[]): void {
    this.writeText(stream, util.formatWithOptions(this.inspectOptionsFor(stream), ...args));
  }

  /** Writes `text` and a newline, every line indented by the current group. */
  private writeText(stream: OutputStream, text: string): void {
    if (this.indent) {
      text = this.indent + text.replace(/\n/g, `\n${this.indent}`);
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
    this.writeText(
      this.out,
      util.inspect(value, {
        customInspect: false,
        ...this.inspectOptionsFor(this.out),
        ...options,
      }),
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
        ...this.inspectOptionsFor(this.out),
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

/** Node's cli_table: `head` over `columns`, cells left-justified. */
function renderTable(head: string[], columns: string[][]): string {
  const rows: string[][] = [];
  const widths = head.map((h) => h.length);
  const longest = Math.max(...columns.map((column) => column.length));
  for (let i = 0; i < head.length; i++) {
    const column = columns[i];
    for (let j = 0; j < longest; j++) {
      rows[j] ??= [];
      const value = (rows[j][i] = Object.prototype.hasOwnProperty.call(column, j) ? column[j] : "");
      widths[i] = Math.max(widths[i] || 0, value.length);
    }
  }
  const renderRow = (row: string[]) =>
    `│ ${row.map((cell, i) => cell + " ".repeat(widths[i] - cell.length)).join(" │ ")} │`;
  const divider = widths.map((width) => "─".repeat(width + 2));
  return [
    `┌${divider.join("┬")}┐`,
    renderRow(head),
    `├${divider.join("┼")}┤`,
    ...rows.map(renderRow),
    `└${divider.join("┴")}┘`,
  ].join("\n");
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
