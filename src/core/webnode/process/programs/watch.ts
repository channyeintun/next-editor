// Watch mode: `node --watch` (Node's lib/internal/main/watch_mode.js and
// lib/internal/watch_mode/files_watcher.js, as Linux runs them) and
// `tsx watch` (tsx's `watch` command). The process started with either is a
// supervisor that runs none of the program's code: it runs the program in a
// child node process, watches the files the child reports loading, and on a
// change ends the child, waits for it to exit (so a server's port is free)
// and starts it again.
//
// The child's side is `watchReporter`: the loader tells it of each file the
// program loads (loader/modules.ts), and it sends them over the child's IPC
// channel as Node's child does (watchReport.ts), or as tsx's loader does
// (`{ type: "dependency", path }`).
import { signalExitStatus } from "../../signals";
import { fileUrl } from "../loader/modules";
import type { LoadKind } from "../loader/modules";
import { spawn } from "../node/child_process";
import { postIpcMessage } from "../node/internal/ipcEnvelope";
import { watch } from "../node/fs/watch";
import path from "../node/path";
import { nodeSignalNumber } from "../node/signalNames";
import type { NodeProcess } from "../node/process";
import { clearTimeout, setTimeout } from "../node/timers";
import { getColorDepth, isatty } from "../node/tty";
import { fileURLToPath } from "../node/url";
import util from "../node/util";
import { runtime } from "../runtime";
import { TSX_CHILD_OPTION } from "./watchOptions";
import type { TsxWatchSettings } from "./watchOptions";
import {
  WATCH_REPORT_ENV,
  watchReportMessage,
  watchReportsIn,
  watchReportsWanted,
} from "./watchReport";

/** The parts of a `ChildProcess` the supervisor uses. */
export interface SupervisedChild {
  readonly killed: boolean;
  kill(signal: string): boolean;
  send(message: unknown): boolean;
  on(event: "exit" | "message", listener: (...args: never[]) => void): unknown;
  off(event: "message", listener: (...args: never[]) => void): unknown;
}

export interface Timer {
  clear(): void;
}

/** What the supervisor needs from the process it runs in. */
export interface WatchHost {
  cwd: string;
  env: Record<string, string>;
  /** Starts `node` with `args` on this process's stdio, with an IPC channel when `ipc`. */
  spawnNode(
    args: string[],
    options: { ipc: boolean; env: Record<string, string | undefined> },
  ): SupervisedChild;
  /** `fs.watch(path, { recursive }, listener)`. Throws when nothing is at `path`. */
  watch(
    target: string,
    recursive: boolean,
    listener: (eventType: string, filename: string | null) => void,
  ): Timer;
  /** What is at `target`, links followed. */
  kind(target: string): "file" | "directory" | null;
  /**
   * The entries of the folder `target`, each with what it is itself (a
   * link as a link); none when it cannot be read.
   */
  entries(target: string): { name: string; link: boolean }[];
  /** `setTimeout`; a timer that does not `keepAlive` is unref'd. */
  setTimer(callback: () => void, ms: number, keepAlive: boolean): Timer;
  /** Writes to standard output. */
  write(text: string): void;
  /** Writes to standard error. */
  writeError(text: string): void;
  onSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
  exit(code: number): void;
  /** The supervisor's own IPC channel to its parent, when it was started with one. */
  parent: {
    send(message: unknown): void;
    on(listener: (message: unknown) => void): void;
    off(listener: (message: unknown) => void): void;
  } | null;
  /** Calls `listener` for each chunk typed on standard input. */
  onInput(listener: () => void): void;
  /** Node's watch-mode colors: standard error is a terminal of more than 2 colors, or FORCE_COLOR says so. */
  nodeColors: boolean;
  /** tsx's colors (kolorist's rule): NO_COLOR, FORCE_COLOR, TERM, CI, or standard output is a terminal. */
  tsxColors: boolean;
  /** The environment alone says more than 2 colors, whatever the streams are: tsx's usage text goes by it. */
  environmentColors: boolean;
  stdoutIsTTY: boolean;
  /** The time as tsx prints it. */
  timeOfDay(): string;
}

/** What the `node` command line asked of watch mode. */
export interface WatchConfig {
  /** The options before the script, as `process.execArgv` lists them. */
  execArgv: string[];
  /** What follows them as given: the script (or `-`) and its arguments. */
  command: string[];
  /** The script, as given. */
  script: string | null;
  /** `--watch-path`: watch these instead of the files the program loads. */
  watchPaths: string[];
  /** `--watch-preserve-output`: do not clear the terminal on a restart. */
  preserveOutput: boolean;
  /** `--watch-kill-signal`, by default SIGTERM. */
  killSignal: string | null;
  envFiles: { path: string; ifExists: boolean }[];
  /** NODE_OPTIONS split into words, or null when it is not set. */
  nodeOptions: string[] | null;
  /** tsx's settings: supervise as `tsx watch` does. */
  tsx: TsxWatchSettings | null;
}

/** Starts watch mode. The supervisor lives on in its watchers, its child and its signal handlers. */
export function runWatchSupervisor(config: WatchConfig, host: WatchHost): void {
  if (config.tsx) {
    superviseTsx(config, config.tsx, host);
  } else {
    superviseNode(config, host);
  }
}

// ---------------------------------------------------------------------------
// node --watch
// ---------------------------------------------------------------------------

const WAITING_FOR_CHANGES = "Waiting for file changes before restarting...";

/** Node's `convertToValidSignal` for a signal given by name. */
function validSignal(value: string): string {
  const name = value.toUpperCase();
  if (nodeSignalNumber(name) > 0) {
    return name;
  }
  const error = Object.assign(new TypeError(`Unknown signal: ${value}`), {
    code: "ERR_UNKNOWN_SIGNAL",
  });
  error.stack = error.stack?.replace(/^TypeError:/, "TypeError [ERR_UNKNOWN_SIGNAL]:");
  throw error;
}

/** Node treats `_` and `-` alike in an option's name. */
function normalizeOptionName(argument: string): string {
  if (!argument.startsWith("--")) {
    return argument;
  }
  const equals = argument.indexOf("=");
  return equals < 0
    ? argument.replaceAll("_", "-")
    : argument.slice(0, equals).replaceAll("_", "-") + argument.slice(equals);
}

/** The supervisor's options without the watch ones, for its child (watch_mode.js). */
function withoutWatchOptions(execArgv: string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const argument = normalizeOptionName(execArgv[index]);
    if (argument.startsWith("--watch=")) {
      continue;
    }
    if (argument === "--watch") {
      // A value that is not an option belongs to --watch.
      const next = execArgv[index + 1];
      if (next && next[0] !== "-") {
        index += 1;
      }
      continue;
    }
    if (argument.startsWith("--watch-path")) {
      if (argument[12] !== "=") {
        index += 1;
      }
      continue;
    }
    if (
      argument === "--config-file" ||
      argument.startsWith("--config-file=") ||
      argument === "--experimental-config-file" ||
      argument.startsWith("--experimental-config-file=") ||
      argument === "--experimental-default-config-file"
    ) {
      continue;
    }
    kept.push(execArgv[index]);
  }
  return kept;
}

/** NODE_OPTIONS without the watch options, so the child does not watch too. */
function withoutWatchNodeOptions(words: string[]): string {
  const kept: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const name = normalizeOptionName(word);
    if (
      name === "--watch" ||
      name === "--watch-preserve-output" ||
      name.startsWith("--watch=") ||
      name.startsWith("--watch-preserve-output=") ||
      name.startsWith("--watch-path=") ||
      name.startsWith("--watch-kill-signal=")
    ) {
      continue;
    }
    if (name === "--watch-path" || name === "--watch-kill-signal") {
      index += 1;
      continue;
    }
    // Quoted again, so a value with a space stays one word.
    kept.push(
      word.includes(" ") || word.includes('"')
        ? `"${word.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
        : word,
    );
  }
  return kept.join(" ");
}

/** Whether `child` is `parent` or inside it. */
function isParentPath(parent: string, child: string): boolean {
  const prefix = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(prefix);
}

/**
 * Node's `FilesWatcher` as Linux runs it: a file is watched through its
 * directory (not recursively), and in "filter" mode only the files the child
 * reported restart it. Changes are debounced: the restart follows the last
 * change of a burst by `debounce` ms.
 */
class FilesWatcher {
  #host: WatchHost;
  #debounce: number;
  #mode: "filter" | "all";
  #watchers = new Map<string, { handle: Timer; recursive: boolean }>();
  #filtered = new Set<string>();
  #ipcHandlers = new WeakMap<
    SupervisedChild,
    { toChild: (message: unknown) => void; toParent: (message: unknown) => void }
  >();
  #debounceTimer: Timer | null = null;
  #debounceTrigger: string | undefined;
  /** Called with the last file that changed, once the changes settle. */
  onChanged: ((trigger: string | undefined) => void) | null = null;

  constructor(host: WatchHost, debounce: number, mode: "filter" | "all") {
    this.#host = host;
    this.#debounce = debounce;
    this.#mode = mode;
  }

  #isPathWatched(target: string): boolean {
    if (this.#watchers.has(target)) {
      return true;
    }
    for (const [watched, watcher] of this.#watchers) {
      if (watcher.recursive && isParentPath(watched, target)) {
        return true;
      }
    }
    return false;
  }

  #removeWatchedChildren(target: string): void {
    for (const [watched, watcher] of this.#watchers) {
      if (watched !== target && isParentPath(target, watched)) {
        watcher.handle.clear();
        this.#watchers.delete(watched);
      }
    }
  }

  #onChange(trigger: string): void {
    if (this.#mode === "filter" && !this.#filtered.has(trigger)) {
      return;
    }
    this.#debounceTrigger = trigger;
    this.#debounceTimer?.clear();
    this.#debounceTimer = this.#host.setTimer(
      () => {
        this.#debounceTimer = null;
        const last = this.#debounceTrigger;
        this.#debounceTrigger = undefined;
        this.onChanged?.(last);
      },
      this.#debounce,
      false,
    );
  }

  /** Watches `target`; `entries`: its events name the entries of a directory. */
  watchPath(target: string, recursive = true, allowMissing = false, entries = recursive): void {
    if (this.#isPathWatched(target)) {
      return;
    }
    let handle: Timer;
    try {
      handle = this.#host.watch(target, recursive, (_eventType, filename) => {
        this.#onChange(entries ? path.resolve(target, filename ?? "") : target);
      });
    } catch (error) {
      if (allowMissing) {
        return;
      }
      throw error;
    }
    this.#watchers.set(target, { handle, recursive });
    if (recursive) {
      this.#removeWatchedChildren(target);
    }
  }

  /** Restarts on changes to `file`: its directory is watched for its entry. */
  filterFile(file: string, allowMissing = false): void {
    if (!file) {
      return;
    }
    this.watchPath(path.dirname(file), false, allowMissing, true);
    this.#filtered.add(file);
  }

  /** Listens for the files `child` reports, and relays IPC when the supervisor has a parent. */
  watchChildProcessModules(child: SupervisedChild): void {
    const parent = this.#host.parent;
    if (parent) {
      const handlers = {
        toChild: (message: unknown) => {
          child.send(message);
        },
        toParent: (message: unknown) => {
          parent.send(message);
        },
      };
      this.#ipcHandlers.set(child, handlers);
      parent.on(handlers.toChild);
      child.on("message", handlers.toParent);
    }
    child.on("message", (message: unknown) => {
      try {
        for (const { kind, files } of watchReportsIn(message)) {
          for (const file of files) {
            this.filterFile(kind === "import" ? fileURLToPath(file as string) : (file as string));
          }
        }
      } catch {
        // A file that cannot be watched is left out, as Node does.
      }
    });
  }

  destroyIPC(child: SupervisedChild): void {
    const handlers = this.#ipcHandlers.get(child);
    if (this.#host.parent && handlers) {
      this.#host.parent.off(handlers.toChild);
      child.off("message", handlers.toParent);
    }
  }

  clearFileFilters(): void {
    this.#filtered.clear();
  }

  clear(): void {
    this.#debounceTimer?.clear();
    this.#debounceTimer = null;
    this.#debounceTrigger = undefined;
    for (const watcher of this.#watchers.values()) {
      watcher.handle.clear();
    }
    this.#watchers.clear();
    this.#filtered.clear();
  }
}

function superviseNode(config: WatchConfig, host: WatchHost): void {
  const killSignal = validSignal(config.killSignal ?? "SIGTERM");
  const filtering = config.watchPaths.length === 0;
  const color = (code: string) => (host.nodeColors ? code : "");
  const blue = color("\x1b[34m");
  const green = color("\x1b[32m");
  const red = color("\x1b[31m");
  const white = color("\x1b[39m");
  const clear = color("\x1bc");
  const commandText = util.inspect(config.command.join(" "));
  const args = [...withoutWatchOptions(config.execArgv), ...config.command];
  const nodeOptions =
    config.nodeOptions === null ? undefined : withoutWatchNodeOptions(config.nodeOptions);

  const watcher = new FilesWatcher(host, 200, filtering ? "filter" : "all");
  for (const watched of config.watchPaths) {
    watcher.watchPath(path.resolve(host.cwd, watched));
  }

  let child: SupervisedChild | null = null;
  let childExit: Promise<number | null> = Promise.resolve(null);
  let exited = false;
  let stopping = false;
  let graceTimer: Timer | null = null;

  const start = () => {
    exited = false;
    stopping = false;
    const started = host.spawnNode(args, {
      ipc: filtering,
      env: { ...host.env, ...WATCH_REPORT_ENV, NODE_OPTIONS: nodeOptions },
    });
    child = started;
    watcher.watchChildProcessModules(started);
    for (const file of config.envFiles) {
      watcher.filterFile(path.resolve(host.cwd, file.path), file.ifExists);
    }
    childExit = new Promise((resolve) => {
      started.on("exit", (code: number | null) => {
        exited = true;
        if (!stopping) {
          host.write(
            code === 0
              ? `${blue}Completed running ${commandText}. ${WAITING_FOR_CHANGES}${white}\n`
              : `${red}Failed running ${commandText}. ${WAITING_FOR_CHANGES}${white}\n`,
          );
        }
        resolve(code);
      });
    });
  };

  const killAndWait = async (signal: string, force: boolean) => {
    const target = child;
    const onExit = childExit;
    if (!target || ((target.killed || exited) && !force)) {
      return undefined;
    }
    stopping = true;
    if (!exited) {
      target.kill(signal);
    }
    return await onExit;
  };

  const stop = async (target: SupervisedChild | null) => {
    if (target) {
      watcher.destroyIPC(target);
    }
    watcher.clearFileFilters();
    // A child that takes more than half a second to stop is reported.
    let reported = false;
    graceTimer?.clear();
    graceTimer = host.setTimer(
      () => {
        reported = true;
        host.write(`${blue}Waiting for graceful termination...${white}\n`);
      },
      500,
      false,
    );
    await killAndWait(killSignal, false);
    graceTimer.clear();
    if (reported) {
      if (!config.preserveOutput) {
        host.write(clear);
      }
      host.write(`${green}Gracefully restarted ${commandText}${white}\n`);
    }
  };

  // A change while a restart is under way is dropped, as in Node.
  let restarting = false;
  const restart = async (trigger: string | undefined) => {
    if (restarting) {
      return;
    }
    restarting = true;
    try {
      if (!config.preserveOutput) {
        host.write(clear);
      }
      if (trigger) {
        host.write(`${blue}Change detected in ${util.inspect(trigger)}${white}\n`);
      }
      host.write(`${green}Restarting ${commandText}${white}\n`);
      await stop(child);
      start();
    } finally {
      restarting = false;
    }
  };

  start();
  watcher.onChanged = (trigger) => {
    void restart(trigger);
  };

  // The supervisor exits once its child has, with the child's code.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    host.onSignal(signal, () => {
      watcher.clear();
      void killAndWait(signal, true).then((code) => host.exit(code ?? 0));
    });
  }
}

// ---------------------------------------------------------------------------
// tsx watch
// ---------------------------------------------------------------------------

/** What tsx's watcher (chokidar) never watches: dot files and folders, and dependencies. */
const TSX_IGNORED = ["**/.*/**", "**/.*", "**/{node_modules,bower_components,vendor}/**"];
/** Editors' swap and temporary files, which chokidar's `atomic` option ignores. */
const EDITOR_TEMPORARY = /\..*\.(sw[px])$|~$|\.subl.*\.tmp/;

/** Whether `pattern` uses glob syntax. */
function isGlob(pattern: string): boolean {
  return /[*?[{]|[!@+]\(/.test(pattern);
}

/** `{a,b}` alternatives expanded into separate patterns, nested ones too. */
function expandBraces(pattern: string): string[] {
  let depth = 0;
  let start = -1;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\") {
      index += 1;
    } else if (character === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        const parts = splitAlternatives(pattern.slice(start + 1, index));
        if (parts.length > 1) {
          const head = pattern.slice(0, start);
          const tail = pattern.slice(index + 1);
          return parts.flatMap((part) => expandBraces(head + part + tail));
        }
      }
    }
  }
  return [pattern];
}

/** The comma-separated parts of a brace body, not splitting inside nested braces. */
function splitAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === "\\") {
      index += 1;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      parts.push(body.slice(from, index));
      from = index + 1;
    }
  }
  parts.push(body.slice(from));
  return parts;
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/** One path segment of a glob: `*`, `?` and `[...]` within it, never across `/`. */
function segmentSource(segment: string): string {
  let source = "";
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (character === "\\" && index + 1 < segment.length) {
      index += 1;
      source += escapeRegExp(segment[index]);
    } else if (character === "*") {
      while (segment[index + 1] === "*") {
        index += 1;
      }
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[" && segment.indexOf("]", index + 2) > 0) {
      const end = segment.indexOf("]", index + 2);
      const body = segment.slice(index + 1, end).replaceAll("\\", "\\\\");
      source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
      index = end;
    } else {
      source += escapeRegExp(character);
    }
  }
  return source;
}

/** A glob without braces as a regular expression for whole paths; `**` spans any number of folders. */
function globToRegExp(glob: string): RegExp {
  const segments = glob.split("/").filter((segment, index, all) => {
    // `**/**` is `**`.
    return !(segment === "**" && all[index - 1] === "**");
  });
  let source = "";
  let afterGlobstar = false;
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      if (last) {
        source += index === 0 ? ".*" : "(?:/.*)?";
      } else {
        source += index === 0 ? "(?:.*/)?" : "/(?:.*/)?";
      }
      afterGlobstar = true;
      return;
    }
    if (index > 0 && !afterGlobstar) {
      source += "/";
    }
    afterGlobstar = false;
    source += segmentSource(segment);
  });
  return new RegExp(`^${source}$`);
}

/**
 * Whether a path matches any of `patterns`, as chokidar's `ignored` list
 * does: each is anchored at `cwd` unless absolute, and a plain path covers
 * everything under it.
 */
function pathMatcher(patterns: string[], cwd: string): (file: string) => boolean {
  const expressions: RegExp[] = [];
  for (const pattern of patterns) {
    let absolute = path.isAbsolute(pattern) ? pattern : path.join(cwd, pattern);
    if (absolute.length > 1 && absolute.endsWith("/")) {
      absolute = absolute.slice(0, -1);
    }
    const globs = isGlob(pattern) ? [absolute] : [absolute, `${absolute}/**`];
    for (const glob of globs) {
      for (const expanded of expandBraces(glob)) {
        expressions.push(globToRegExp(expanded));
      }
    }
  }
  return (file) => expressions.some((expression) => expression.test(file));
}

/** The folder a glob's matches are all under: its path up to the first segment with glob syntax. */
function globBase(glob: string): string {
  const segments = glob.split("/");
  const index = segments.findIndex((segment) => isGlob(segment));
  const base = segments.slice(0, index < 0 ? segments.length : index).join("/");
  return base === "" ? "/" : base;
}

interface Run {
  child: SupervisedChild;
  running: boolean;
}

/** What tsx's watcher knows of a path it has had an event for. */
interface Watched {
  /** Nothing was there at its last event, so the next one adds it. */
  missing: boolean;
  /** It was a folder when last seen. */
  directory: boolean;
}

/**
 * What `tsx watch --help` prints (tsx 4.23, as into a pipe; on a terminal tsx
 * fits the flags to its width). The headings are bold where the environment
 * has colors, and capitals where it has none.
 */
function tsxWatchUsage(colors: boolean): string {
  const heading = (text: string) => (colors ? `\x1b[1m${text}\x1b[22m` : text.toUpperCase());
  return [
    "tsx watch",
    "",
    "Run the script and watch for changes",
    "",
    heading("Usage:"),
    "  tsx watch [flags...] <script path>",
    "",
    heading("Flags:"),
    "      --clear-screen             Clearing the screen on rerun (default: true)",
    "      --exclude <string>         Paths & globs to exclude from being watched",
    "  -h, --help                     Show help",
    "      --ignore <string>          Paths & globs to exclude from being watched (Deprecated: use --exclude)",
    "      --include <string>         Additional paths & globs to watch",
    "      --no-cache                 Disable caching",
    "      --tsconfig <string>        Custom tsconfig.json path",
    "",
    "",
  ].join("\n");
}

/** tsx's `watch` command: tsx's messages, its watched files and its way of restarting. */
function superviseTsx(config: WatchConfig, settings: TsxWatchSettings, host: WatchHost): void {
  if (config.command.length === 0) {
    // Nothing to run (`tsx watch`, or its options alone): tsx refuses before
    // it watches or starts anything.
    host.writeError('Error: Missing required parameter "script path"\n\n');
    host.write(tsxWatchUsage(host.environmentColors));
    host.exit(1);
    return;
  }
  const { cwd } = host;
  // kolorist, as tsx colors: a color closed inside the text is opened again.
  const style = (open: number, close: number) => {
    const closing = new RegExp(`\\x1b\\[${close}m`, "g");
    return (text: string) =>
      host.tsxColors
        ? `\x1b[${open}m${text.replace(closing, `\x1b[${open}m`)}\x1b[${close}m`
        : text;
  };
  const gray = style(90, 39);
  const cyan = style(96, 39);
  const yellow = style(33, 39);
  const magenta = style(95, 39);
  const green = style(92, 39);
  const log = (...parts: string[]) =>
    host.write(`${[gray(host.timeOfDay()), cyan("[tsx]"), ...parts].join(" ")}\n`);

  // `--include !x` excludes x. A dependency at exactly such a path is still
  // watched: tsx gives it a watcher of its own that only the defaults and
  // `--exclude` apply to.
  const negated = settings.include
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));
  const included = settings.include.filter((pattern) => !pattern.startsWith("!"));
  const exactlyIncluded = new Set(
    negated.filter((pattern) => !isGlob(pattern)).map((pattern) => path.resolve(cwd, pattern)),
  );
  const byDefault = pathMatcher([...TSX_IGNORED, ...settings.exclude], cwd);
  const byAll = pathMatcher([...TSX_IGNORED, ...settings.exclude, ...negated], cwd);
  const ignoredByDefault = (file: string) => EDITOR_TEMPORARY.test(file) || byDefault(file);
  const ignored = (file: string) => EDITOR_TEMPORARY.test(file) || byAll(file);

  let current: Run | null = null;
  let stopping = false;
  let killing = false;
  let watching = false;

  /**
   * chokidar's event names: a file that appears is added, one that goes is
   * unlinked, and a folder is named as one (`addDir`, `unlinkDir`). What a
   * removed entry was is known only once it has been seen.
   */
  const eventName = (file: string, entry: Watched) => {
    const kind = host.kind(file);
    if (kind === null) {
      entry.missing = true;
      return entry.directory ? "unlinkDir" : "unlink";
    }
    entry.directory = kind === "directory";
    if (entry.missing) {
      entry.missing = false;
      return entry.directory ? "addDir" : "add";
    }
    return "change";
  };

  // The same event from both of tsx's watchers within a second counts once.
  const recent = new Map<string, { source: string; timer: Timer }>();
  const onEvent = (source: string, event: string, file: string) => {
    if (!watching) {
      return;
    }
    const key = `${event}:${file}`;
    const seen = recent.get(key);
    if (seen && seen.source !== source) {
      seen.timer.clear();
      recent.delete(key);
      return;
    }
    seen?.timer.clear();
    const entry = {
      source,
      timer: host.setTimer(
        () => {
          if (recent.get(key) === entry) {
            recent.delete(key);
          }
        },
        1000,
        false,
      ),
    };
    recent.set(key, entry);
    rerun(event, path.relative(cwd, file));
  };

  // The script and the files the program loads, each through its folder.
  const files = new Map<string, Watched>();
  const folders = new Map<string, Timer>();
  const watchFile = (file: string, skip: (file: string) => boolean) => {
    if (files.has(file) || skip(file)) {
      return;
    }
    const folder = path.dirname(file);
    if (!folders.has(folder)) {
      try {
        folders.set(
          folder,
          host.watch(folder, false, (_eventType, name) => {
            const changed = path.resolve(folder, name ?? "");
            const entry = files.get(changed);
            if (entry) {
              onEvent("literal", eventName(changed, entry), changed);
            }
          }),
        );
      } catch {
        // A folder that is not there cannot be watched; chokidar skips it too.
        return;
      }
    }
    files.set(file, { missing: host.kind(file) === null, directory: false });
  };

  // `--include`: each path, or each glob under the folder it starts from.
  const watchIncluded = (pattern: string) => {
    const absolute = path.isAbsolute(pattern) ? pattern : path.join(cwd, pattern);
    const glob = isGlob(pattern);
    const matches = glob
      ? pathMatcher([absolute], "/")
      : (file: string) => file === absolute || isParentPath(absolute, file);
    let base = glob ? globBase(absolute) : absolute;
    while (host.kind(base) === null && base !== "/") {
      base = path.dirname(base);
    }
    const isFolder = host.kind(base) === "directory";
    const seen = new Map<string, Watched>();
    if (isFolder) {
      seen.set(base, { missing: false, directory: true });
      // chokidar's first scan: what each entry is, so that one that goes is
      // named as what it was (`unlinkDir` for a folder). Not into what is
      // ignored, nor through a link, which may lead back up.
      const scan = (folder: string) => {
        for (const { name, link } of host.entries(folder)) {
          const file = path.join(folder, name);
          if (ignored(file)) {
            continue;
          }
          const directory = host.kind(file) === "directory";
          seen.set(file, { missing: false, directory });
          if (directory && !link) {
            scan(file);
          }
        }
      };
      scan(base);
    }
    // The folder's own removal and re-creation are reported under its own
    // name, like an entry of that name inside it: while the folder is gone,
    // and when it comes back, that name means the folder.
    let gone = false;
    try {
      host.watch(base, isFolder, (eventType, name) => {
        let file = isFolder ? path.resolve(base, name ?? "") : base;
        if (isFolder && name === path.basename(base) && (gone || host.kind(base) === null)) {
          file = base;
          gone = host.kind(base) === null;
        }
        if (!matches(file) || ignored(file)) {
          return;
        }
        let entry = seen.get(file);
        if (!entry) {
          entry = { missing: eventType === "rename", directory: false };
          seen.set(file, entry);
        }
        onEvent("include", eventName(file, entry), file);
      });
    } catch {
      // Nothing there to watch.
    }
  };

  const onReport = (message: unknown) => {
    if (
      typeof message !== "object" ||
      message === null ||
      (message as { type?: unknown }).type !== "dependency"
    ) {
      return;
    }
    const reported = (message as { path?: unknown }).path;
    if (typeof reported !== "string") {
      return;
    }
    let file: string;
    try {
      file = reported.startsWith("file:") ? fileURLToPath(reported) : reported;
    } catch {
      return;
    }
    if (path.isAbsolute(file)) {
      watchFile(file, exactlyIncluded.has(file) ? ignoredByDefault : ignored);
    }
  };

  const childArgs = [
    host.parent ? `${TSX_CHILD_OPTION}=ipc` : TSX_CHILD_OPTION,
    ...config.execArgv,
    ...config.command,
  ];
  const env: Record<string, string> = { ...host.env };
  if (settings.noCache) {
    env.TSX_DISABLE_CACHE = "1";
  }
  if (settings.tsconfig) {
    env.TSX_TSCONFIG_PATH = settings.tsconfig;
  }
  const spawnChild = (): Run | null => {
    if (stopping) {
      return null;
    }
    const child = host.spawnNode(childArgs, { ipc: true, env });
    const run: Run = { child, running: true };
    child.on("exit", () => {
      run.running = false;
    });
    child.on("message", onReport);
    return run;
  };

  /**
   * The code tsx's program exits with. tsx's loader turns SIGINT and SIGTERM
   * into `process.exit(128 + signal)`; here the signal ends the program.
   */
  const exitCodeOf = (code: number | null, signal: string | null) =>
    code ?? (signal === "SIGINT" || signal === "SIGTERM" ? signalExitStatus(signal) : null);

  const killProcess = (run: Run, signal = "SIGTERM", timeoutMs = 5000) =>
    new Promise<number | null>((resolve) => {
      let exited = false;
      run.child.on("exit", (code: number | null, ended: string | null) => {
        exited = true;
        killing = false;
        resolve(exitCodeOf(code, ended));
      });
      killing = true;
      run.child.kill(signal);
      host.setTimer(
        () => {
          if (!exited) {
            log(
              yellow(`Process didn't exit in ${Math.floor(timeoutMs / 1000)}s. Force killing...`),
            );
            run.child.kill("SIGKILL");
          }
        },
        timeoutMs,
        true,
      );
    });

  // Changes within 100 ms of each other rerun once, for the last of them.
  // fs.watch tells of one file in several events where chokidar emits one:
  // a new file's first write is part of its "add", and a file deleted and
  // created again within 100 ms (chokidar's `atomic` window) "change"d.
  let rerunTimer: Timer | null = null;
  let pending: { event?: string; file?: string } = {};
  const rerun = (event?: string, file?: string) => {
    if (file !== undefined && file === pending.file) {
      if (pending.event === "add" && event === "change") {
        event = "add";
      } else if (pending.event === "unlink" && event === "add") {
        event = "change";
      }
    }
    pending = { event, file };
    rerunTimer?.clear();
    rerunTimer = host.setTimer(
      () => {
        rerunTimer = null;
        const last = pending;
        pending = {};
        void rerunNow(last.event, last.file);
      },
      100,
      true,
    );
  };
  const rerunNow = async (event?: string, file?: string) => {
    const what = event ? `${magenta(event)}${file ? ` in ${green(`./${file}`)}` : ""}` : "";
    if (killing && current) {
      log(what, yellow("Process hasn't exited. Killing process..."));
      current.child.kill("SIGKILL");
      return;
    }
    if (current) {
      if (current.running) {
        log(what, yellow("Restarting..."));
        await killProcess(current);
      } else {
        log(what, yellow("Rerunning..."));
      }
      if (settings.clearScreen && host.stdoutIsTTY) {
        host.write("\x1Bc");
      }
    }
    current = spawnChild();
  };

  const relaySignal = (signal: "SIGINT" | "SIGTERM") => {
    stopping = true;
    if (current?.running) {
      if (killing) {
        log(yellow("Previous process hasn't exited yet. Force killing..."));
      }
      void killProcess(current, killing ? "SIGKILL" : signal).then((code) => host.exit(code ?? 0));
    } else {
      host.exit(signalExitStatus(signal));
    }
  };
  host.onSignal("SIGINT", () => relaySignal("SIGINT"));
  host.onSignal("SIGTERM", () => relaySignal("SIGTERM"));

  if (config.script !== null) {
    watchFile(path.resolve(cwd, config.script), ignored);
  }
  for (const pattern of included) {
    watchIncluded(pattern);
  }
  watching = true;
  current = spawnChild();
  host.onInput(() => rerun("Return key"));
}

// ---------------------------------------------------------------------------
// The child's side
// ---------------------------------------------------------------------------

/**
 * What the loader reports through in a program a watch supervisor started,
 * or null in any other. Node's child sends each file it loads, and each file
 * a failed require() looked for, over its IPC channel when its supervisor
 * asked for the reports (watchReport.ts); under tsx (`tsxChild`) the reports use
 * the channel the supervisor opened even when the program is not given it.
 * A worker thread (`parentPort`) posts Node's messages to its parent, which
 * passes them on (node/worker_threads.ts). Each file is sent once.
 */
export function watchReporter(options: {
  env: Record<string, string>;
  process: NodeProcess;
  ipc: MessagePort | null;
  tsxChild: boolean;
  /** A worker thread's port to its parent; null in the main thread. */
  parentPort: MessagePort | null;
}): ((kind: LoadKind, filename: string) => void) | null {
  const { ipc, process, parentPort } = options;
  const sent = new Set<string>();
  if (parentPort !== null) {
    if (!watchReportsWanted(options.env)) {
      return null;
    }
    // Node's thread reports neither what a failed require() looked for nor
    // anything under tsx (whose supervisor does not set the variable).
    return (kind, filename) => {
      if (kind !== "missing" && !sent.has(filename)) {
        sent.add(filename);
        parentPort.postMessage(watchMessage(kind, filename));
      }
    };
  }
  if (ipc === null) {
    return null;
  }
  if (options.tsxChild) {
    // tsx's loader reports what it loads for `import`, and for `require` the
    // files its compiler handles: not JSON, nor what was looked for in vain.
    return (kind, filename) => {
      const skipped =
        kind === "missing" ||
        (kind === "require" && (filename.endsWith(".json") || filename.endsWith(".node")));
      if (!skipped && !sent.has(filename)) {
        sent.add(filename);
        postIpcMessage(ipc, { type: "dependency", path: filename });
      }
    };
  }
  if (!watchReportsWanted(options.env)) {
    return null;
  }
  const send = process.send as (message: unknown) => boolean;
  return (kind, filename) => {
    if (sent.has(filename) || process.connected !== true) {
      return;
    }
    sent.add(filename);
    send.call(process, watchMessage(kind, filename));
  };
}

/** Node's report of a file: by URL for `import`; what a failed require() looked for counts as required. */
function watchMessage(kind: LoadKind, filename: string): Record<string, unknown[]> {
  return kind === "import"
    ? watchReportMessage("import", [fileUrl(filename)])
    : watchReportMessage("require", [filename]);
}

// ---------------------------------------------------------------------------
// The real host
// ---------------------------------------------------------------------------

const CI_VENDORS = [
  "TRAVIS",
  "CIRCLECI",
  "APPVEYOR",
  "GITLAB_CI",
  "GITHUB_ACTIONS",
  "BUILDKITE",
  "DRONE",
];

/** kolorist's rule, which tsx colors by. */
function tsxColorsEnabled(env: Record<string, string>, stdoutIsTTY: boolean): boolean {
  if (env.NODE_DISABLE_COLORS || env.NO_COLOR || env.FORCE_COLOR === "0") {
    return false;
  }
  if (env.FORCE_COLOR === "1" || env.FORCE_COLOR === "2" || env.FORCE_COLOR === "3") {
    return true;
  }
  if (env.TERM === "dumb") {
    return false;
  }
  if ("CI" in env && CI_VENDORS.some((name) => name in env)) {
    return true;
  }
  return stdoutIsTTY;
}

/** The supervisor's host in a node process: its builtins and its process. */
export function processWatchHost(process: NodeProcess): WatchHost {
  const env = process.env;
  const stdoutIsTTY = process.stdout.isTTY === true;
  const connected = process.connected === true;
  const send = process.send as (message: unknown) => boolean;
  return {
    cwd: process.cwd(),
    env: { ...env },
    spawnNode: (args, options) =>
      spawn(process.execPath as string, args, {
        stdio: options.ipc ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
        env: options.env,
      }),
    watch: (target, recursive, listener) => {
      const watcher = watch(target, { recursive, persistent: true }, listener);
      return { clear: () => watcher.close() };
    },
    kind: (target) => {
      try {
        const type = runtime().fs.stat(target, true).mode & 0o170000;
        return type === 0o040000 ? "directory" : "file";
      } catch {
        return null;
      }
    },
    entries: (target) => {
      try {
        return runtime()
          .fs.readdir(target)
          .map((entry) => ({ name: entry.name, link: entry.type === "symlink" }));
      } catch {
        return [];
      }
    },
    setTimer: (callback, ms, keepAlive) => {
      const timer = setTimeout(callback, ms);
      if (!keepAlive) {
        timer.unref();
      }
      return { clear: () => clearTimeout(timer) };
    },
    write: (text) => {
      process.stdout.write(text);
    },
    writeError: (text) => {
      process.stderr.write(text);
    },
    onSignal: (signal, handler) => {
      process.on(signal, handler);
    },
    exit: (code) => {
      process.exit(code);
    },
    parent: connected
      ? {
          send: (message) => {
            send.call(process, message);
          },
          on: (listener) => {
            process.on("message", listener);
          },
          off: (listener) => {
            process.off("message", listener);
          },
        }
      : null,
    onInput: (listener) => {
      process.stdin.on("data", listener);
    },
    nodeColors:
      env.FORCE_COLOR !== undefined ? getColorDepth(env) > 2 : isatty(2) && getColorDepth(env) > 2,
    tsxColors: tsxColorsEnabled(env, stdoutIsTTY),
    environmentColors: getColorDepth(env) > 2,
    stdoutIsTTY,
    timeOfDay: () => new Date().toLocaleTimeString(),
  };
}
