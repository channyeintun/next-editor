// tsx's command line, and the private options that carry `tsx watch` to the
// node program. tsx's watch is a supervisor like `node --watch`, with tsx's
// own messages and rules (process/programs/watch.ts): `tsxArguments` turns
// `tsx watch …` into node with TSX_WATCH_OPTION (kernel/exec.ts calls it for
// the `tsx` command), and the supervisor starts its program with
// TSX_CHILD_OPTION. node.ts reads both and keeps them out of process.execArgv.
// Nothing here imports anything: the kernel bundle includes this file.

/** `--webnode-tsx-watch=<TsxWatchSettings as JSON>`: run as tsx's watch supervisor. */
export const TSX_WATCH_OPTION = "--webnode-tsx-watch";

/**
 * Given to the program a tsx watch supervisor starts: report each file it
 * loads, as tsx's loader does. Alone, the program has no IPC channel of its
 * own, as under tsx (the reports use one the program cannot see).
 * `=ipc`: the supervisor has an IPC parent, so tsx gives the program a channel.
 */
export const TSX_CHILD_OPTION = "--webnode-tsx-child";

/** `tsx watch`'s own options. */
export interface TsxWatchSettings {
  /** `--include`: more paths and globs to watch (`!` before one excludes). */
  include: string[];
  /** `--exclude` and the deprecated `--ignore`: paths and globs never watched. */
  exclude: string[];
  /** `--clear-screen` (default true): clear the terminal before each rerun. */
  clearScreen: boolean;
  /** `--no-cache`: the program gets TSX_DISABLE_CACHE=1. */
  noCache: boolean;
  /** `--tsconfig`: the program gets TSX_TSCONFIG_PATH. */
  tsconfig: string | null;
}

/**
 * tsx's own options under each spelling its parser accepts (a camelCase flag
 * also answers to its kebab-case name), and whether each takes a value.
 * `watch` adds the second set. `--no-clear-screen` is not one of them: tsx
 * passes it on to node, like any option it does not know.
 */
const TSX_OPTIONS = new Map([
  ["--tsconfig", true],
  ["--no-cache", false],
  ["--noCache", false],
]);
const TSX_WATCH_OPTIONS = new Map([
  ["--clear-screen", false],
  ["--clearScreen", false],
  ["--ignore", true],
  ["--include", true],
  ["--exclude", true],
]);

/** What tsx's parser takes for an option rather than for an option's value. */
const TSX_FLAG = /^-{1,2}\w/;

/**
 * The arguments `tsx` runs node with. As tsx does, it removes its own options
 * up to the first argument that is not an option (the script, or an option's
 * value) and passes everything else on: Node's options (`--env-file`,
 * `--import`, `--conditions` …) and what follows the script. `watch` makes
 * node tsx's watch supervisor, with tsx's watch options as its settings; with
 * no script left, the supervisor says so as tsx does (watch.ts).
 */
export function tsxArguments(args: string[]): string[] {
  const rest = [...args];
  const watch = rest[0] === "watch";
  if (watch || rest[0] === "run") {
    rest.shift();
  }
  const kept: string[] = [];
  const settings: TsxWatchSettings = {
    include: [],
    exclude: [],
    clearScreen: true,
    noCache: false,
    tsconfig: null,
  };
  const ignore: string[] = [];
  while (rest.length > 0 && rest[0].startsWith("-") && rest[0] !== "--") {
    const argument = rest.shift()!;
    const equals = argument.indexOf("=");
    const name = equals > 0 ? argument.slice(0, equals) : argument;
    const takesValue = TSX_OPTIONS.get(name) ?? (watch ? TSX_WATCH_OPTIONS.get(name) : undefined);
    if (takesValue === undefined) {
      kept.push(argument);
      continue;
    }
    let value = equals > 0 ? argument.slice(equals + 1) : undefined;
    if (takesValue && value === undefined) {
      // tsx's parser takes the next argument, unless it is an option: then "".
      value = rest.length > 0 && rest[0] !== "--" && !TSX_FLAG.test(rest[0]) ? rest.shift()! : "";
    }
    switch (name) {
      case "--tsconfig":
        settings.tsconfig = value ?? "";
        break;
      case "--no-cache":
      case "--noCache":
        settings.noCache = value !== "false";
        break;
      case "--clear-screen":
      case "--clearScreen":
        settings.clearScreen = value !== "false";
        break;
      case "--ignore":
        ignore.push(value ?? "");
        break;
      case "--include":
        settings.include.push(value ?? "");
        break;
      default:
        settings.exclude.push(value ?? "");
    }
  }
  if (!watch) {
    return [...kept, ...rest];
  }
  settings.exclude = [...ignore, ...settings.exclude];
  return [`${TSX_WATCH_OPTION}=${JSON.stringify(settings)}`, ...kept, ...rest];
}
