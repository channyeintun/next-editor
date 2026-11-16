// The `tty` builtin: `isatty`, and the terminal streams `ReadStream` (raw
// mode) and `WriteStream` (window size, `resize`, colour depth, cursor
// helpers) over the process's terminal fds, from `runtime().tty`. The colour
// decision table is lib/internal/tty.js from Node 22, ported unchanged.
import type { ReadableOptions, WritableOptions } from "./stream";
import { FdReadable, FdWritable } from "./internal/fdStreams";
import { validateInteger } from "./internalErrors";
import { clearLine, clearScreenDown, cursorTo, moveCursor } from "./readline";
import { runtime } from "../runtime";

/** True when `fd` is a terminal. */
export function isatty(fd: unknown): boolean {
  if (!Number.isInteger(fd) || (fd as number) < 0 || (fd as number) > 2147483647) {
    return false;
  }
  try {
    return runtime().tty.isatty(fd as number);
  } catch {
    return false;
  }
}

const COLORS_2 = 1;
const COLORS_16 = 4;
const COLORS_256 = 8;
const COLORS_16m = 24;

const TERM_ENVS: Readonly<Record<string, number>> = {
  eterm: COLORS_16,
  cons25: COLORS_16,
  console: COLORS_16,
  cygwin: COLORS_16,
  dtterm: COLORS_16,
  gnome: COLORS_16,
  hurd: COLORS_16,
  jfbterm: COLORS_16,
  konsole: COLORS_16,
  kterm: COLORS_16,
  mlterm: COLORS_16,
  mosh: COLORS_16m,
  putty: COLORS_16,
  st: COLORS_16,
  "rxvt-unicode-24bit": COLORS_16m,
  terminator: COLORS_16m,
  "xterm-kitty": COLORS_16m,
};

const CI_ENVS: readonly (readonly [string, number])[] = [
  ["APPVEYOR", COLORS_256],
  ["BUILDKITE", COLORS_256],
  ["CIRCLECI", COLORS_16m],
  ["DRONE", COLORS_256],
  ["GITEA_ACTIONS", COLORS_16m],
  ["GITHUB_ACTIONS", COLORS_16m],
  ["GITLAB_CI", COLORS_256],
  ["TRAVIS", COLORS_256],
];

const TERM_ENVS_REG_EXP = [
  /ansi/,
  /color/,
  /linux/,
  /direct/,
  /^con[0-9]*x[0-9]/,
  /^rxvt/,
  /^screen/,
  /^xterm/,
  /^vt100/,
  /^vt220/,
];

type Env = Record<string, string | undefined>;

let warned = false;
function warnOnDeactivatedColors(env: Env): void {
  if (warned) {
    return;
  }
  let name = "";
  if (env.NODE_DISABLE_COLORS !== undefined) {
    name = "NODE_DISABLE_COLORS";
  }
  if (env.NO_COLOR !== undefined) {
    if (name !== "") {
      name += "' and '";
    }
    name += "NO_COLOR";
  }
  if (name !== "") {
    const proc = (globalThis as { process?: { emitWarning?: (m: string, t: string) => void } })
      .process;
    proc?.emitWarning?.(
      `The '${name}' env is ignored due to the 'FORCE_COLOR' env being set.`,
      "Warning",
    );
    warned = true;
  }
}

function defaultEnv(): Env {
  try {
    return runtime().env;
  } catch {
    return {};
  }
}

/** Node's `getColorDepth(env)`: 1, 4, 8 or 24 bits. The platform is always linux. */
export function getColorDepth(env: Env = defaultEnv()): number {
  if (env.FORCE_COLOR !== undefined) {
    switch (env.FORCE_COLOR) {
      case "":
      case "1":
      case "true":
        warnOnDeactivatedColors(env);
        return COLORS_16;
      case "2":
        warnOnDeactivatedColors(env);
        return COLORS_256;
      case "3":
        warnOnDeactivatedColors(env);
        return COLORS_16m;
      default:
        return COLORS_2;
    }
  }
  if (env.NODE_DISABLE_COLORS !== undefined || env.NO_COLOR !== undefined || env.TERM === "dumb") {
    return COLORS_2;
  }
  if (env.TMUX) {
    return COLORS_16m;
  }
  if ("TF_BUILD" in env && "AGENT_NAME" in env) {
    return COLORS_16;
  }
  if ("CI" in env) {
    for (const [name, colors] of CI_ENVS) {
      if (name in env) {
        return colors;
      }
    }
    if (env.CI_NAME === "codeship") {
      return COLORS_256;
    }
    return COLORS_2;
  }
  if ("TEAMCITY_VERSION" in env) {
    return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.exec(env.TEAMCITY_VERSION ?? "") !== null
      ? COLORS_16
      : COLORS_2;
  }
  switch (env.TERM_PROGRAM) {
    case "iTerm.app":
      if (!env.TERM_PROGRAM_VERSION || /^[0-2]\./.exec(env.TERM_PROGRAM_VERSION) !== null) {
        return COLORS_256;
      }
      return COLORS_16m;
    case "HyperTerm":
    case "MacTerm":
      return COLORS_16m;
    case "Apple_Terminal":
      return COLORS_256;
  }
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") {
    return COLORS_16m;
  }
  if (env.TERM) {
    if (/truecolor/.exec(env.TERM) !== null) {
      return COLORS_16m;
    }
    if (/^xterm-256/.exec(env.TERM) !== null) {
      return COLORS_256;
    }
    const termEnv = env.TERM.toLowerCase();
    if (Object.hasOwn(TERM_ENVS, termEnv)) {
      return TERM_ENVS[termEnv];
    }
    if (TERM_ENVS_REG_EXP.some((term) => term.exec(termEnv) !== null)) {
      return COLORS_16;
    }
  }
  if (env.COLORTERM) {
    return COLORS_16;
  }
  return COLORS_2;
}

/** Node's `hasColors([count][, env])`. */
export function hasColors(count?: unknown, env?: Env): boolean {
  if (env === undefined && (count === undefined || (typeof count === "object" && count !== null))) {
    env = count as Env | undefined;
    count = 16;
  } else {
    validateInteger(count, "count", 2);
  }
  return (count as number) <= 2 ** getColorDepth(env);
}

/** `tty.ReadStream`: the terminal's input side. */
export class ReadStream extends FdReadable {
  /** Always true. */
  readonly isTTY = true;
  /** Whether raw mode is on. */
  isRaw = false;

  constructor(fd: number, options?: ReadableOptions) {
    super(fd, options);
  }

  /** Turns raw mode on or off (each key delivered as typed, no echo). */
  setRawMode(mode: boolean): this {
    const flag = !!mode;
    try {
      runtime().tty.setRawMode(this.fd, flag);
    } catch (error) {
      this.emit("error", error);
      return this;
    }
    this.isRaw = flag;
    return this;
  }
}

/** `tty.WriteStream`: the terminal's output side. */
export class WriteStream extends FdWritable {
  /** Always true. */
  readonly isTTY = true;
  #size: { columns: number; rows: number } | null = null;
  #override: { columns?: number; rows?: number } = {};

  constructor(fd: number, options?: WritableOptions) {
    super(fd, options);
    try {
      this.#size = this.#read();
      const stop = runtime().tty.onResize(() => this._refreshSize());
      this.once("close", stop);
    } catch {
      // Not a terminal, or no runtime: the size stays unknown.
    }
  }

  #read(): { columns: number; rows: number } {
    return runtime().tty.windowSize(this.fd);
  }

  /** Re-reads the window size and emits `resize` when it changed. */
  _refreshSize(): void {
    let next: { columns: number; rows: number };
    try {
      next = this.#read();
    } catch (error) {
      this.emit("error", error);
      return;
    }
    const previous = this.#size;
    this.#size = next;
    this.#override = {};
    if (previous === null || previous.columns !== next.columns || previous.rows !== next.rows) {
      this.emit("resize");
    }
  }

  /** The terminal's width, read live. */
  get columns(): number {
    if (this.#override.columns !== undefined) {
      return this.#override.columns;
    }
    try {
      return this.#read().columns;
    } catch {
      return this.#size?.columns ?? 80;
    }
  }

  set columns(value: number) {
    this.#override.columns = value;
  }

  /** The terminal's height, read live. */
  get rows(): number {
    if (this.#override.rows !== undefined) {
      return this.#override.rows;
    }
    try {
      return this.#read().rows;
    } catch {
      return this.#size?.rows ?? 24;
    }
  }

  set rows(value: number) {
    this.#override.rows = value;
  }

  /** `[columns, rows]`. */
  getWindowSize(): [number, number] {
    return [this.columns, this.rows];
  }

  /** See the module's `getColorDepth`. */
  getColorDepth(env?: Env): number {
    return getColorDepth(env);
  }

  /** See the module's `hasColors`. */
  hasColors(count?: unknown, env?: Env): boolean {
    return hasColors(count, env);
  }

  /** `readline.cursorTo(this, x, y, callback)`. */
  cursorTo(x: number, y?: number | (() => void), callback?: () => void): boolean {
    return cursorTo(this, x, y, callback);
  }

  /** `readline.moveCursor(this, dx, dy, callback)`. */
  moveCursor(dx: number, dy: number, callback?: () => void): boolean {
    return moveCursor(this, dx, dy, callback);
  }

  /** `readline.clearLine(this, dir, callback)`. */
  clearLine(dir: number, callback?: () => void): boolean {
    return clearLine(this, dir, callback);
  }

  /** `readline.clearScreenDown(this, callback)`. */
  clearScreenDown(callback?: () => void): boolean {
    return clearScreenDown(this, callback);
  }
}

/** `require("tty")`. */
const tty = { isatty, ReadStream, WriteStream };

export default tty;
