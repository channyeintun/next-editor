// Command lines, per tool: which tool `argv[0]` names (`npx` is npm's exec,
// `pnpx` is `pnpm dlx`, `bunx` is `bun x`), its global options, its command
// aliases, and how each command takes its flags and passes arguments on.
// Unknown flags are accepted and ignored.
import type { SaveType } from "./manifest";
import type { Tool } from "./output";
import { basename } from "./paths";

/** How `exec` finds its command: local bins only, local then install, or always a fresh install. */
export type ExecMode = "local" | "auto" | "dlx";

/** A parsed command. */
export type Command =
  | { kind: "install" }
  | { kind: "add"; specs: string[]; save: SaveType; exact: boolean }
  | { kind: "remove"; names: string[] }
  | { kind: "update" }
  | { kind: "run"; script: string | null; args: string[]; ifPresent: boolean }
  /** A script when the manifest has it, else a local bin (pnpm/yarn/bun `<name>`). */
  | { kind: "implicit"; name: string; args: string[] }
  | {
      kind: "exec";
      mode: ExecMode;
      /** The command to run; null with `packages` set means "the package's own bin". */
      command: string | null;
      args: string[];
      /** Packages to install for the command (`-p`, or the command's own package). */
      packages: string[];
      /** `-c '<shell line>'`. */
      shell: string | null;
    }
  | { kind: "create"; name: string; args: string[] }
  | { kind: "init"; yes: boolean }
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "ls" }
  | { kind: "why"; names: string[] }
  | { kind: "noop"; name: string }
  | { kind: "global"; name: string }
  | { kind: "unknown"; name: string };

/** A parsed command line. */
export interface Invocation {
  tool: Tool;
  /** The name the program was invoked as (`npx`, `pnpm`, …). */
  invokedAs: string;
  command: Command;
  /** `-C`, `--dir`, `--prefix`, `--cwd`. */
  dir: string | null;
  /** `--registry`. */
  registry: string | null;
}

/** Global flags that take a value (as the next argument unless written `--flag=value`). */
const VALUE_FLAGS = new Set([
  "-C",
  "--dir",
  "--prefix",
  "--cwd",
  "--registry",
  "--filter",
  "-F",
  "--loglevel",
  "--reporter",
  "--workspace",
  "--cache",
  "--userconfig",
  "--modules-folder",
  "--network-timeout",
  "--mutex",
]);

const NPM_INSTALL = new Set([
  "install",
  "i",
  "in",
  "ins",
  "inst",
  "insta",
  "instal",
  "isnt",
  "isnta",
  "isntal",
  "isntall",
  "add",
  "ci",
  "clean-install",
  "ic",
  "install-clean",
  "isntall-clean",
]);
const REMOVE = new Set(["remove", "rm", "r", "un", "uninstall", "unlink"]);
const RUN = new Set(["run", "run-script", "rum", "urn"]);
const UPDATE = new Set(["update", "up", "upgrade", "udpate"]);
const LS = new Set(["ls", "list", "la", "ll"]);
const WHY = new Set(["why", "explain"]);
const NOOP = new Set([
  "config",
  "c",
  "set",
  "get",
  "cache",
  "store",
  "prune",
  "dedupe",
  "ddp",
  "audit",
  "fund",
  "outdated",
  "doctor",
  "rebuild",
  "rb",
  "approve-builds",
  "version",
  "pm",
  "setup",
]);
const NPM_IMPLICIT_RUN = new Map([
  ["start", "start"],
  ["test", "test"],
  ["t", "test"],
  ["tst", "test"],
  ["stop", "stop"],
  ["restart", "restart"],
]);

/** The tool and the command an invoked name implies. */
function toolOf(argv0: string): { tool: Tool; invokedAs: string; prefix: string[] } {
  const name = basename(argv0)
    .replace(/\.(c|m)?js$/, "")
    .replace(/-cli$/, "");
  switch (name) {
    case "npx":
      return { tool: "npm", invokedAs: "npx", prefix: ["exec"] };
    case "pnpx":
      return { tool: "pnpm", invokedAs: "pnpx", prefix: ["dlx"] };
    case "bunx":
      return { tool: "bun", invokedAs: "bunx", prefix: ["x"] };
    case "pnpm":
    case "yarn":
    case "bun":
      return { tool: name, invokedAs: name, prefix: [] };
    default:
      return { tool: "npm", invokedAs: "npm", prefix: [] };
  }
}

function flagName(arg: string): string {
  const equals = arg.indexOf("=");
  return equals === -1 ? arg : arg.slice(0, equals);
}

/** Splits `--flag=value`; the value is null when it is written as the next argument. */
function flagValue(arg: string): string | null {
  const equals = arg.indexOf("=");
  return equals === -1 ? null : arg.slice(equals + 1);
}

/** Parses a command line (`argv[0]` is the invoked name). */
export function parseArgs(argv: string[]): Invocation {
  const { tool, invokedAs, prefix } = toolOf(argv[0] ?? "npm");
  const rest = [...prefix, ...argv.slice(1)];
  if (prefix.length > 0 && (argv[1] === "-v" || argv[1] === "--version")) {
    return { tool, invokedAs, command: { kind: "version" }, dir: null, registry: null };
  }
  const invocation: Invocation = {
    tool,
    invokedAs,
    command: { kind: "help" },
    dir: null,
    registry: null,
  };
  let global = false;

  // Global options before the command.
  let index = 0;
  while (index < rest.length && rest[index].startsWith("-") && rest[index] !== "--") {
    const arg = rest[index];
    const name = flagName(arg);
    if ((name === "-v" || name === "--version") && index === 0) {
      invocation.command = { kind: "version" };
      return invocation;
    }
    if (name === "-h" || name === "--help") {
      invocation.command = { kind: "help" };
      return invocation;
    }
    if (name === "-g" || name === "--global") {
      global = true;
    }
    if (VALUE_FLAGS.has(name)) {
      let value = flagValue(arg);
      if (value === null) {
        value = rest[index + 1] ?? "";
        index++;
      }
      if (name === "-C" || name === "--dir" || name === "--prefix" || name === "--cwd") {
        invocation.dir = value;
      } else if (name === "--registry") {
        invocation.registry = value;
      }
    }
    index++;
  }
  const commandName = rest[index];
  const args = rest.slice(index + 1);
  if (commandName === undefined) {
    invocation.command = tool === "yarn" ? { kind: "install" } : { kind: "help" };
    return invocation;
  }

  // Options after the command that are not the command's own.
  const own: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const name = flagName(arg);
    if (name === "-g" || name === "--global") {
      global = true;
    }
    if (VALUE_FLAGS.has(name)) {
      let value = flagValue(arg);
      if (value === null) {
        value = args[i + 1] ?? "";
        i++;
      }
      if (name === "-C" || name === "--dir" || name === "--prefix" || name === "--cwd") {
        invocation.dir = value;
      } else if (name === "--registry") {
        invocation.registry = value;
      }
      continue;
    }
    own.push(arg);
  }

  invocation.command = parseCommand(tool, commandName, args, own);
  if (global && ["install", "add", "remove", "update", "ls"].includes(invocation.command.kind)) {
    invocation.command = { kind: "global", name: commandName };
  }
  return invocation;
}

function parseCommand(tool: Tool, name: string, raw: string[], args: string[]): Command {
  if (name === "help" || name === "--help") {
    return { kind: "help" };
  }
  if (name === "-v" || name === "--version") {
    return { kind: "version" };
  }
  const installNames =
    tool === "npm"
      ? NPM_INSTALL
      : new Set(tool === "bun" ? ["install", "i", "add", "a"] : ["install", "i", "add", "ci"]);
  if (installNames.has(name)) {
    return parseInstall(tool, args);
  }
  if (REMOVE.has(name)) {
    return { kind: "remove", names: args.filter((arg) => !arg.startsWith("-")) };
  }
  if (UPDATE.has(name)) {
    return { kind: "update" };
  }
  if (RUN.has(name)) {
    return parseRun(tool, raw);
  }
  if (name === "exec" || name === "x" || name === "dlx") {
    const mode: ExecMode =
      name === "dlx" ? "dlx" : tool === "npm" || tool === "bun" ? "auto" : "local";
    return parseExec(mode, raw);
  }
  if (name === "create" || (tool === "npm" && (name === "init" || name === "innit"))) {
    const positional = raw.findIndex((arg) => !arg.startsWith("-"));
    if (positional !== -1) {
      return { kind: "create", name: raw[positional], args: raw.slice(positional + 1) };
    }
    if (name === "create") {
      return { kind: "unknown", name: "create" };
    }
  }
  if (name === "init" || name === "innit") {
    return { kind: "init", yes: args.some((arg) => arg === "-y" || arg === "--yes") };
  }
  if (LS.has(name)) {
    return { kind: "ls" };
  }
  if (WHY.has(name)) {
    return { kind: "why", names: args.filter((arg) => !arg.startsWith("-")) };
  }
  if (NOOP.has(name)) {
    return { kind: "noop", name };
  }
  if (tool === "npm") {
    const script = NPM_IMPLICIT_RUN.get(name);
    if (script) {
      return { ...parseRunArgs("npm", raw), kind: "run", script };
    }
    return { kind: "unknown", name };
  }
  return { kind: "implicit", name, args: dropLeadingDashes(raw) };
}

function parseInstall(tool: Tool, args: string[]): Command {
  let save: SaveType = "prod";
  let exact = false;
  const specs: string[] = [];
  for (const arg of args) {
    const name = flagName(arg);
    switch (name) {
      case "-D":
      case "--save-dev":
      case "--dev":
      case "-d":
        save = "dev";
        break;
      case "-O":
      case "--save-optional":
      case "--optional":
        save = "optional";
        break;
      case "--save-peer":
      case "--peer":
        save = "peer";
        break;
      case "-P":
        save = tool === "yarn" ? "peer" : "prod";
        break;
      case "--save-prod":
      case "--prod":
        save = "prod";
        break;
      case "-E":
      case "--save-exact":
      case "--exact":
        exact = true;
        break;
      default:
        if (!arg.startsWith("-")) {
          specs.push(arg);
        }
    }
  }
  return specs.length > 0 ? { kind: "add", specs, save, exact } : { kind: "install" };
}

function dropLeadingDashes(args: string[]): string[] {
  return args[0] === "--" ? args.slice(1) : args;
}

/** The script arguments after the script name, per tool. */
function parseRunArgs(tool: Tool, afterScript: string[]): { args: string[]; ifPresent: boolean } {
  let ifPresent = false;
  if (tool !== "npm") {
    return { args: dropLeadingDashes(afterScript), ifPresent };
  }
  // npm: flags before `--` configure npm; positionals and everything after `--` go to the script.
  const args: string[] = [];
  for (let i = 0; i < afterScript.length; i++) {
    const arg = afterScript[i];
    if (arg === "--") {
      args.push(...afterScript.slice(i + 1));
      break;
    }
    if (arg === "--if-present") {
      ifPresent = true;
    } else if (!arg.startsWith("-")) {
      args.push(arg);
    }
  }
  return { args, ifPresent };
}

function parseRun(tool: Tool, raw: string[]): Command {
  let ifPresent = false;
  let i = 0;
  while (i < raw.length && raw[i].startsWith("-") && raw[i] !== "--") {
    if (raw[i] === "--if-present") {
      ifPresent = true;
    }
    i++;
  }
  if (raw[i] === "--") {
    i++;
  }
  const script = raw[i] ?? null;
  if (script === null) {
    return { kind: "run", script: null, args: [], ifPresent };
  }
  const parsed = parseRunArgs(tool, raw.slice(i + 1));
  return { kind: "run", script, args: parsed.args, ifPresent: ifPresent || parsed.ifPresent };
}

function parseExec(mode: ExecMode, raw: string[]): Command {
  const packages: string[] = [];
  let shell: string | null = null;
  let i = 0;
  while (i < raw.length && raw[i].startsWith("-")) {
    const arg = raw[i];
    const name = flagName(arg);
    if (arg === "--") {
      i++;
      break;
    }
    if (name === "-p" || name === "--package") {
      const value = flagValue(arg) ?? raw[++i];
      if (value !== undefined) {
        packages.push(value);
      }
    } else if (name === "-c" || name === "--call") {
      shell = flagValue(arg) ?? raw[++i] ?? "";
    }
    i++;
  }
  const command = shell === null ? (raw[i] ?? null) : null;
  const args = shell === null ? raw.slice(i + 1) : [];
  return { kind: "exec", mode, command, args, packages, shell };
}

/** The create-package spec for `<tool> create <name>`: `vite@5` → `create-vite@5`, `@s/x` → `@s/create-x`. */
export function createPackageSpec(name: string): string {
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    if (slash === -1) {
      const at = name.indexOf("@", 1);
      return at === -1 ? `${name}/create` : `${name.slice(0, at)}/create${name.slice(at)}`;
    }
    return `${name.slice(0, slash)}/create-${name.slice(slash + 1)}`;
  }
  return `create-${name}`;
}

/** Splits `name@range` (a scoped name keeps its leading `@`). */
export function splitSpec(spec: string): { name: string; range: string | null } {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return at === -1
    ? { name: spec, range: null }
    : { name: spec.slice(0, at), range: spec.slice(at + 1) };
}
