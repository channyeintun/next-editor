// Shell builtins: the commands that read or change the shell's own state
// (`cd`, `export`, `set`, `read`, `source`, `trap`, …). The stateless file
// and text commands live in commands/.
import { X_OK } from "../../../kernel/vfs/types";
import { runtime } from "../../runtime";
import { HOME_DIR } from "../../platform";
import { COMMANDS } from "./commands/index";
import { evaluateTest } from "./commands/test";
import { errorText, isDir, tryStat } from "./commands/util";
import { ExitSignal, LoopSignal, ReturnSignal } from "./context";
import { arithmetic } from "./expand";
import type { CommandIo } from "./io";
import { decode } from "./io";
import type { Builtin, Shell } from "./interpreter";
import { declareHandledSignals, signalName, signalNumber } from "./signals";
import { shellQuote } from "./quote";
import { isReservedWord } from "./parser";

function usage(io: CommandIo, name: string, message: string, status = 2): number {
  io.err(`sh: ${name}: ${message}\n`);
  return status;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Finds an executable on `PATH`; null when none. */
export function searchPath(name: string, pathVar: string | undefined, cwd: string): string | null {
  const fs = runtime().fs;
  const candidates = name.includes("/")
    ? [name.startsWith("/") ? name : `${cwd}/${name}`]
    : (pathVar ?? "")
        .split(":")
        .map(
          (dir) =>
            `${(dir || ".").startsWith("/") ? dir || "." : `${cwd}/${dir || "."}`}`.replace(
              /\/$/,
              "",
            ) + `/${name}`,
        );
  for (const candidate of candidates) {
    try {
      fs.access(candidate, X_OK);
      const stat = tryStat(candidate);
      if (stat && !isDir(stat)) {
        return candidate;
      }
    } catch {
      // Not here.
    }
  }
  return null;
}

/** How `type` describes `name`, or null when it is not found. */
function describe(
  shell: Shell,
  name: string,
): { kind: string; text: string; path?: string } | null {
  if (shell.aliases.has(name)) {
    return { kind: "alias", text: `${name} is aliased to \`${shell.aliases.get(name)}'` };
  }
  if (isReservedWord(name)) {
    return { kind: "keyword", text: `${name} is a shell keyword` };
  }
  if (shell.functions.has(name)) {
    return { kind: "function", text: `${name} is a function` };
  }
  if (BUILTINS[name] || COMMANDS[name]) {
    return { kind: "builtin", text: `${name} is a shell builtin` };
  }
  const path = searchPath(name, shell.get("PATH"), shell.cwd);
  if (path) {
    return { kind: "file", text: `${name} is ${path}`, path };
  }
  return null;
}

const cd: Builtin = (shell, args, io) => {
  if (args[0] === "-L" || args[0] === "-P" || args[0] === "--") {
    args = args.slice(1);
  }
  let target = args[0];
  let print = false;
  if (target === undefined) {
    target = shell.get("HOME") ?? HOME_DIR;
  } else if (target === "-") {
    const old = shell.get("OLDPWD");
    if (old === undefined) {
      return usage(io, "cd", "OLDPWD not set", 1);
    }
    target = old;
    print = true;
  }
  if (args.length > 1) {
    return usage(io, "cd", "too many arguments", 1);
  }
  const path = shell.resolve(target);
  const stat = tryStat(path);
  if (!stat) {
    return usage(io, "cd", `${target}: No such file or directory`, 1);
  }
  if (!isDir(stat)) {
    return usage(io, "cd", `${target}: Not a directory`, 1);
  }
  shell.chdir(path);
  if (print) {
    io.out(`${path}\n`);
  }
  return 0;
};

const pwd: Builtin = (shell, args, io) => {
  if (args.includes("-P")) {
    try {
      io.out(`${runtime().fs.realpath(shell.cwd)}\n`);
      return 0;
    } catch (error) {
      return usage(io, "pwd", errorText(error), 1);
    }
  }
  io.out(`${shell.cwd}\n`);
  return 0;
};

function exitStatusArg(
  shell: Shell,
  io: CommandIo,
  name: string,
  arg: string | undefined,
): number | null {
  if (arg === undefined) {
    return shell.status;
  }
  if (!/^-?\d+$/.test(arg)) {
    usage(io, name, `${arg}: numeric argument required`);
    return null;
  }
  return ((Number(arg) % 256) + 256) % 256;
}

const exit: Builtin = (shell, args, io) => {
  const status = exitStatusArg(shell, io, "exit", args[0]);
  throw new ExitSignal(status ?? 2);
};

const returnBuiltin: Builtin = (shell, args, io) => {
  if (shell.functionDepth === 0 && shell.sourceDepth === 0) {
    return usage(io, "return", "can only `return' from a function or sourced script", 1);
  }
  const status = exitStatusArg(shell, io, "return", args[0]);
  throw new ReturnSignal(status ?? 2);
};

function loopControl(kind: "break" | "continue"): Builtin {
  return (shell, args, io) => {
    if (shell.loopDepth === 0) {
      return usage(io, kind, "only meaningful in a `for', `while', or `until' loop", 0);
    }
    const levels = args[0] === undefined ? 1 : Number(args[0]);
    if (!Number.isInteger(levels) || levels < 1) {
      return usage(io, kind, `${args[0]}: loop count out of range`, 1);
    }
    throw new LoopSignal(kind, Math.min(levels, shell.loopDepth));
  };
}

function assignArg(
  shell: Shell,
  io: CommandIo,
  name: string,
  arg: string,
): { name: string; ok: boolean } {
  const eq = arg.indexOf("=");
  const varName = eq < 0 ? arg : arg.slice(0, eq);
  if (!NAME.test(varName)) {
    usage(io, name, `\`${arg}': not a valid identifier`, 1);
    return { name: varName, ok: false };
  }
  if (eq >= 0) {
    try {
      shell.set(varName, arg.slice(eq + 1));
    } catch (error) {
      io.err(`sh: ${(error as Error).message}\n`);
      return { name: varName, ok: false };
    }
  }
  return { name: varName, ok: true };
}

const exportBuiltin: Builtin = (shell, args, io) => {
  let unexport = false;
  const names: string[] = [];
  for (const arg of args) {
    if (arg === "-p") {
      continue;
    }
    if (arg === "-n") {
      unexport = true;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      return usage(io, "export", `${arg}: invalid option`);
    }
    names.push(arg);
  }
  if (names.length === 0) {
    for (const [name, variable] of [...shell.vars].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (variable.exported) {
        io.out(`export ${name}=${shellQuote(variable.value)}\n`);
      }
    }
    return 0;
  }
  let status = 0;
  for (const arg of names) {
    const result = assignArg(shell, io, "export", arg);
    if (!result.ok) {
      status = 1;
      continue;
    }
    const variable = shell.vars.get(result.name);
    if (variable) {
      variable.exported = !unexport;
    } else if (!unexport) {
      shell.vars.set(result.name, { value: "", exported: true, readonly: false });
      // An exported but unset name: bash keeps it unset; we drop it from the env.
      shell.vars.delete(result.name);
    }
  }
  return status;
};

const readonlyBuiltin: Builtin = (shell, args, io) => {
  const names = args.filter((arg) => arg !== "-p");
  if (names.length === 0) {
    for (const [name, variable] of shell.vars) {
      if (variable.readonly) {
        io.out(`readonly ${name}=${shellQuote(variable.value)}\n`);
      }
    }
    return 0;
  }
  let status = 0;
  for (const arg of names) {
    const result = assignArg(shell, io, "readonly", arg);
    if (!result.ok) {
      status = 1;
      continue;
    }
    const variable = shell.vars.get(result.name);
    if (variable) {
      variable.readonly = true;
    } else {
      shell.vars.set(result.name, { value: "", exported: false, readonly: true });
    }
  }
  return status;
};

const local: Builtin = (shell, args, io) => {
  let status = 0;
  for (const arg of args.filter((a) => !a.startsWith("-"))) {
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (!NAME.test(name)) {
      usage(io, "local", `\`${arg}': not a valid identifier`, 1);
      status = 1;
      continue;
    }
    if (!shell.makeLocal(name)) {
      return usage(io, "local", "can only be used in a function", 1);
    }
    if (eq >= 0) {
      shell.set(name, arg.slice(eq + 1));
    } else if (!shell.vars.has(name)) {
      shell.set(name, "");
    }
  }
  return status;
};

const declare: Builtin = (shell, args, io) => {
  let exported = false;
  let readonly = false;
  let print = false;
  const names: string[] = [];
  for (const arg of args) {
    if (/^[-+][a-zA-Z]+$/.test(arg)) {
      for (const flag of arg.slice(1)) {
        if (flag === "x") {
          exported = arg[0] === "-";
        } else if (flag === "r") {
          readonly = true;
        } else if (flag === "p") {
          print = true;
        } else if (flag === "g" || flag === "i" || flag === "l" || flag === "u") {
          // Accepted; integer and case attributes are not tracked.
        } else if (flag === "f" || flag === "F") {
          for (const name of shell.functions.keys()) {
            io.out(`${name}\n`);
          }
          return 0;
        } else {
          return usage(io, "declare", `-${flag}: not supported`);
        }
      }
      continue;
    }
    names.push(arg);
  }
  if (names.length === 0 || print) {
    const list = names.length > 0 ? names : [...shell.vars.keys()].sort();
    for (const name of list) {
      const variable = shell.vars.get(name);
      if (variable) {
        const flags = `${variable.exported ? "x" : ""}${variable.readonly ? "r" : ""}` || "-";
        io.out(
          `declare -${flags.replace(/^-$/, "-")} ${name}=${shellQuote(variable.value)}\n`.replace(
            "--",
            "-",
          ),
        );
      }
    }
    return 0;
  }
  let status = 0;
  for (const arg of names) {
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (shell.functionDepth > 0 && NAME.test(name)) {
      shell.makeLocal(name);
    }
    const result = assignArg(shell, io, "declare", arg);
    if (!result.ok) {
      status = 1;
      continue;
    }
    let variable = shell.vars.get(result.name);
    if (!variable) {
      variable = { value: "", exported: false, readonly: false };
      shell.vars.set(result.name, variable);
    }
    if (exported) {
      variable.exported = true;
    }
    if (readonly) {
      variable.readonly = true;
    }
  }
  return status;
};

const unset: Builtin = (shell, args, io) => {
  let functions = false;
  let status = 0;
  for (const arg of args) {
    if (arg === "-f") {
      functions = true;
      continue;
    }
    if (arg === "-v") {
      functions = false;
      continue;
    }
    if (functions) {
      shell.functions.delete(arg);
      continue;
    }
    if (!NAME.test(arg)) {
      usage(io, "unset", `\`${arg}': not a valid identifier`, 1);
      status = 1;
      continue;
    }
    if (!shell.unset(arg)) {
      usage(io, "unset", `${arg}: cannot unset: readonly variable`, 1);
      status = 1;
    }
  }
  return status;
};

const OPTION_LETTERS: Record<string, keyof Shell["options"]> = {
  e: "errexit",
  x: "xtrace",
  u: "nounset",
  f: "noglob",
  C: "noclobber",
  a: "allexport",
  v: "verbose",
};

const OPTION_NAMES = new Set([
  "errexit",
  "xtrace",
  "nounset",
  "pipefail",
  "noglob",
  "noclobber",
  "allexport",
  "verbose",
]);

/** Applies one `set` flag argument (`-e`, `+x`, …). Returns an error message or null. */
export function applySetFlag(shell: Shell, arg: string): string | null {
  const on = arg[0] === "-";
  for (const letter of arg.slice(1)) {
    const option = OPTION_LETTERS[letter];
    if (option) {
      shell.options[option] = on;
    } else if (
      letter === "h" ||
      letter === "m" ||
      letter === "B" ||
      letter === "H" ||
      letter === "b" ||
      letter === "T" ||
      letter === "E" ||
      letter === "P"
    ) {
      // Accepted with no effect: hashing, job control and history are always on.
    } else {
      return `${arg[0]}${letter}: invalid option`;
    }
  }
  return null;
}

const set: Builtin = (shell, args, io) => {
  if (args.length === 0) {
    for (const name of [...shell.vars.keys()].sort()) {
      io.out(`${name}=${shellQuote(shell.vars.get(name)?.value ?? "")}\n`);
    }
    return 0;
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      shell.positional = args.slice(i + 1);
      return 0;
    }
    if (arg === "-o" || arg === "+o") {
      const name = args[i + 1];
      if (name === undefined) {
        for (const option of OPTION_NAMES) {
          const value = shell.options[option as keyof Shell["options"]];
          io.out(
            arg === "-o"
              ? `${option.padEnd(15)} ${value ? "on" : "off"}\n`
              : `set ${value ? "-" : "+"}o ${option}\n`,
          );
        }
        return 0;
      }
      i++;
      if (OPTION_NAMES.has(name)) {
        shell.options[name as keyof Shell["options"]] = arg === "-o";
      } else if (
        [
          "emacs",
          "vi",
          "monitor",
          "hashall",
          "braceexpand",
          "interactive-comments",
          "posix",
          "notify",
          "history",
        ].includes(name)
      ) {
        // Accepted with no effect.
      } else {
        return usage(io, "set", `${name}: invalid option name`);
      }
      continue;
    }
    if ((arg.startsWith("-") || arg.startsWith("+")) && arg.length > 1) {
      const error = applySetFlag(shell, arg);
      if (error) {
        return usage(io, "set", error);
      }
      continue;
    }
    if (arg === "-") {
      shell.options.xtrace = false;
      shell.options.verbose = false;
      shell.positional = args.slice(i + 1);
      return 0;
    }
    shell.positional = args.slice(i);
    return 0;
  }
  return 0;
};

const shift: Builtin = (shell, args, io) => {
  const count = args[0] === undefined ? 1 : Number(args[0]);
  if (!Number.isInteger(count) || count < 0) {
    return usage(io, "shift", `${args[0]}: numeric argument required`, 1);
  }
  if (count > shell.positional.length) {
    return 1;
  }
  shell.positional = shell.positional.slice(count);
  return 0;
};

/** Splits a line for `read` into `count` fields on IFS; the last one keeps the rest. */
export function splitForRead(line: string, ifs: string, count: number): string[] {
  const white: string[] = Array.from(ifs).filter((c) => c === " " || c === "\t" || c === "\n");
  const isWhite = (c: string): boolean => white.includes(c);
  const isDelim = (c: string): boolean => ifs.includes(c);
  const fields: string[] = [];
  let i = 0;
  const skipWhite = (): void => {
    while (i < line.length && isWhite(line[i])) {
      i++;
    }
  };
  skipWhite();
  while (fields.length < count - 1 && i < line.length) {
    let field = "";
    while (i < line.length && !isDelim(line[i])) {
      field += line[i];
      i++;
    }
    fields.push(field);
    skipWhite();
    if (i < line.length && isDelim(line[i]) && !isWhite(line[i])) {
      i++;
      skipWhite();
    }
  }
  let rest = line.slice(i);
  // Trailing IFS whitespace is trimmed from the last field.
  let end = rest.length;
  while (end > 0 && isWhite(rest[end - 1])) {
    end--;
  }
  rest = rest.slice(0, end);
  if (i < line.length || fields.length < count) {
    fields.push(rest);
  }
  while (fields.length < count) {
    fields.push("");
  }
  return fields;
}

const read: Builtin = async (shell, args, io) => {
  let raw = false;
  let prompt: string | null = null;
  let delimiter = "\n";
  let nchars: number | null = null;
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (names.length === 0 && arg.startsWith("-") && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if (flag === "r") {
          raw = true;
        } else if (flag === "s") {
          // Silent input: our caller turns off echo only in a terminal; nothing to do.
        } else if (flag === "p" || flag === "d" || flag === "n") {
          const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
          if (value === undefined) {
            return usage(io, "read", `-${flag}: option requires an argument`);
          }
          if (flag === "p") {
            prompt = value;
          } else if (flag === "d") {
            delimiter = value === "" ? "\0" : value[0];
          } else {
            nchars = Number(value);
          }
          break;
        } else {
          return usage(io, "read", `-${flag}: not supported`);
        }
      }
      continue;
    }
    if (!NAME.test(arg)) {
      return usage(io, "read", `\`${arg}': not a valid identifier`, 1);
    }
    names.push(arg);
  }
  if (prompt !== null && io.isTty(0)) {
    io.err(prompt);
  }
  const real = io.fd(0);
  if (real === null) {
    return 1;
  }
  let text = "";
  let eof = false;
  if (nchars === null) {
    for (;;) {
      const result = await io.readLine(delimiter.charCodeAt(0));
      if (!result) {
        eof = true;
        break;
      }
      text += result.line;
      if (result.eof) {
        eof = true;
        break;
      }
      if (!raw && delimiter === "\n" && text.endsWith("\\") && !text.endsWith("\\\\")) {
        text = text.slice(0, -1);
        continue;
      }
      break;
    }
  } else {
    const bytes: number[] = [];
    for (;;) {
      const chunk = await io.readChunk(1);
      if (chunk.length === 0) {
        eof = true;
        break;
      }
      bytes.push(chunk[0]);
      if (nchars !== null && decode(Uint8Array.from(bytes)).length >= nchars) {
        break;
      }
    }
    text = decode(Uint8Array.from(bytes));
  }
  if (!raw) {
    text = text.replace(/\\(.)/g, "$1");
  }
  const targets = names.length > 0 ? names : ["REPLY"];
  const ifs = shell.get("IFS") ?? " \t\n";
  const fields = names.length === 0 ? [text] : splitForRead(text, ifs, targets.length);
  targets.forEach((name, index) => shell.set(name, fields[index] ?? ""));
  return eof && text === "" ? 1 : eof ? 1 : 0;
};

/** Finds a file for `source`: a path, or a name on `PATH`, then the working directory. */
function findSourceFile(shell: Shell, name: string): string | null {
  if (name.includes("/")) {
    return shell.resolve(name);
  }
  for (const dir of (shell.get("PATH") ?? "").split(":")) {
    const path = shell.resolve(`${dir || "."}/${name}`);
    const stat = tryStat(path);
    if (stat && !isDir(stat)) {
      return path;
    }
  }
  return shell.resolve(name);
}

const source: Builtin = async (shell, args, io) => {
  const name = args[0];
  if (name === undefined) {
    return usage(io, ".", "filename argument required");
  }
  const path = findSourceFile(shell, name);
  let text: string;
  try {
    text = decode(runtime().fs.readFile(path ?? name));
  } catch (error) {
    return usage(io, name, errorText(error), 1);
  }
  const savedPositional = shell.positional;
  if (args.length > 1) {
    shell.positional = args.slice(1);
  }
  shell.sourceDepth++;
  try {
    return await shell.runSource(text, io.fds);
  } catch (error) {
    if (error instanceof ReturnSignal) {
      return error.status;
    }
    throw error;
  } finally {
    shell.sourceDepth--;
    if (args.length > 1) {
      shell.positional = savedPositional;
    }
  }
};

const evalBuiltin: Builtin = (shell, args, io) => {
  const text = args.join(" ");
  if (text.trim() === "") {
    return 0;
  }
  shell.sourceDepth++;
  return shell.runSource(text, io.fds).finally(() => {
    shell.sourceDepth--;
  });
};

const execBuiltin: Builtin = async (shell, args, io) => {
  // `exec` with redirections only is handled by the interpreter.
  if (args[0] === "-a" || args[0] === "-c" || args[0] === "-l") {
    return usage(io, "exec", `${args[0]}: not supported`);
  }
  const status = await shell.execArgv(args, io.fds, true);
  throw new ExitSignal(status);
};

const alias: Builtin = (shell, args, io) => {
  if (args.length === 0 || args[0] === "-p") {
    for (const [name, value] of [...shell.aliases].sort()) {
      io.out(`alias ${name}=${shellQuote(value)}\n`);
    }
    return 0;
  }
  let status = 0;
  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq > 0) {
      shell.aliases.set(arg.slice(0, eq), arg.slice(eq + 1));
      continue;
    }
    const value = shell.aliases.get(arg);
    if (value === undefined) {
      usage(io, "alias", `${arg}: not found`, 1);
      status = 1;
    } else {
      io.out(`alias ${arg}=${shellQuote(value)}\n`);
    }
  }
  return status;
};

const unalias: Builtin = (shell, args, io) => {
  if (args[0] === "-a") {
    shell.aliases.clear();
    return 0;
  }
  let status = 0;
  for (const arg of args) {
    if (!shell.aliases.delete(arg)) {
      usage(io, "unalias", `${arg}: not found`, 1);
      status = 1;
    }
  }
  return status;
};

const type: Builtin = (shell, args, io) => {
  let status = 0;
  let pathOnly = false;
  let typeOnly = false;
  for (const name of args) {
    if (name === "-p" || name === "-P") {
      pathOnly = true;
      continue;
    }
    if (name === "-t") {
      typeOnly = true;
      continue;
    }
    if (name === "-a") {
      continue;
    }
    const found = describe(shell, name);
    if (!found) {
      if (!typeOnly && !pathOnly) {
        io.err(`sh: type: ${name}: not found\n`);
      }
      status = 1;
      continue;
    }
    if (pathOnly) {
      if (found.path) {
        io.out(`${found.path}\n`);
      }
    } else if (typeOnly) {
      io.out(`${found.kind}\n`);
    } else {
      io.out(`${found.text}\n`);
    }
  }
  return status;
};

const which: Builtin = (shell, args, io) => {
  let status = 0;
  let all = false;
  for (const name of args) {
    if (name === "-a") {
      all = true;
      continue;
    }
    if (name === "-s") {
      continue;
    }
    const path = searchPath(name, shell.get("PATH"), shell.cwd);
    if (path) {
      io.out(`${path}\n`);
      if (!all) {
        continue;
      }
    }
    if (!path && (BUILTINS[name] || COMMANDS[name])) {
      io.out(`${name}: shell built-in command\n`);
      continue;
    }
    if (!path) {
      status = 1;
    }
  }
  return status;
};

const command: Builtin = async (shell, args, io) => {
  let verbose: "v" | "V" | null = null;
  let i = 0;
  for (; i < args.length; i++) {
    if (args[i] === "-v") {
      verbose = "v";
    } else if (args[i] === "-V") {
      verbose = "V";
    } else if (args[i] === "-p") {
      // Default PATH: ours is the default already.
    } else if (args[i] === "--") {
      i++;
      break;
    } else {
      break;
    }
  }
  const rest = args.slice(i);
  if (verbose) {
    let status = 0;
    for (const name of rest) {
      const found = describe(shell, name);
      if (!found) {
        if (verbose === "V") {
          io.err(`sh: command: ${name}: not found\n`);
        }
        status = 1;
        continue;
      }
      if (verbose === "V") {
        io.out(`${found.text}\n`);
      } else if (found.kind === "alias") {
        io.out(`alias ${name}=${shellQuote(shell.aliases.get(name) ?? "")}\n`);
      } else {
        io.out(`${found.path ?? name}\n`);
      }
    }
    return status;
  }
  if (rest.length === 0) {
    return 0;
  }
  return shell.execArgv(rest, io.fds, true);
};

const builtinBuiltin: Builtin = (shell, args, io) => {
  const name = args[0];
  if (name === undefined) {
    return 0;
  }
  if (!BUILTINS[name] && !COMMANDS[name]) {
    return usage(io, "builtin", `${name}: not a shell builtin`, 1);
  }
  return shell.execArgv(args, io.fds, true);
};

const trap: Builtin = (shell, args, io) => {
  if (args.length === 0 || args[0] === "-p") {
    for (const [signal, action] of shell.traps) {
      io.out(`trap -- ${shellQuote(action)} ${signal}\n`);
    }
    return 0;
  }
  if (args[0] === "-l") {
    io.out(
      "1) SIGHUP 2) SIGINT 3) SIGQUIT 9) SIGKILL 10) SIGUSR1 12) SIGUSR2 13) SIGPIPE 14) SIGALRM 15) SIGTERM\n",
    );
    return 0;
  }
  let action: string | null = args[0];
  let signals = args.slice(1);
  if (/^\d+$/.test(action) || (args.length === 1 && action !== "-")) {
    // `trap SIG…` alone resets.
    signals = args;
    action = null;
  } else if (action === "-") {
    action = null;
  }
  let status = 0;
  for (const raw of signals) {
    let name = raw.toUpperCase().replace(/^SIG/, "");
    if (/^\d+$/.test(name)) {
      name = name === "0" ? "EXIT" : (signalName(Number(name))?.replace(/^SIG/, "") ?? name);
    }
    if (name === "ERR" || name === "DEBUG" || name === "RETURN") {
      io.err(`sh: trap: ${name}: not supported\n`);
      status = 1;
      continue;
    }
    if (name !== "EXIT" && signalNumber(name) === undefined) {
      io.err(`sh: trap: ${raw}: invalid signal specification\n`);
      status = 1;
      continue;
    }
    if (action === null) {
      shell.traps.delete(name);
    } else {
      shell.traps.set(name, action);
    }
  }
  declareHandledSignals(shell.traps.keys());
  return status;
};

const wait: Builtin = async (shell, args, io) => {
  const jobs = shell.process.jobs;
  if (args.length === 0) {
    let status = 0;
    for (const job of jobs) {
      status = await job.done;
    }
    jobs.length = 0;
    return status;
  }
  let status = 0;
  for (const arg of args) {
    let job = undefined;
    if (arg.startsWith("%")) {
      job = jobs.find((candidate) => candidate.id === Number(arg.slice(1)));
    } else {
      job = jobs.find((candidate) => candidate.pid === Number(arg));
    }
    if (!job) {
      usage(io, "wait", `pid ${arg} is not a child of this shell`, 127);
      status = 127;
      continue;
    }
    status = await job.done;
    jobs.splice(jobs.indexOf(job), 1);
  }
  return status;
};

const kill: Builtin = (shell, args, io) => {
  let signal = "SIGTERM";
  let i = 0;
  if (args[0] === "-l" || args[0] === "-L") {
    if (args[1] !== undefined) {
      const n = Number(args[1]);
      const name = signalName(n > 128 ? n - 128 : n);
      if (!name) {
        return usage(io, "kill", `${args[1]}: invalid signal specification`, 1);
      }
      io.out(`${name.replace(/^SIG/, "")}\n`);
      return 0;
    }
    io.out(
      "HUP INT QUIT ILL TRAP ABRT BUS FPE KILL USR1 SEGV USR2 PIPE ALRM TERM CHLD CONT STOP TSTP WINCH\n",
    );
    return 0;
  }
  if (args[0] === "-s" || args[0] === "-n") {
    const value = args[1] ?? "";
    const number = /^\d+$/.test(value) ? Number(value) : signalNumber(value);
    if (number === undefined) {
      return usage(io, "kill", `${value}: invalid signal specification`, 1);
    }
    signal = number === 0 ? "0" : (signalName(number) ?? "SIGTERM");
    i = 2;
  } else if (args[0]?.startsWith("-") && args[0] !== "--") {
    const value = args[0].slice(1);
    const number = /^\d+$/.test(value) ? Number(value) : signalNumber(value);
    if (number === undefined) {
      return usage(io, "kill", `${value}: invalid signal specification`, 1);
    }
    signal = number === 0 ? "0" : (signalName(number) ?? "SIGTERM");
    i = 1;
  } else if (args[0] === "--") {
    i = 1;
  }
  const targets = args.slice(i);
  if (targets.length === 0) {
    return usage(
      io,
      "kill",
      "usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ...",
      2,
    );
  }
  let status = 0;
  for (const target of targets) {
    let pid: number | null = null;
    if (target.startsWith("%")) {
      pid = shell.process.jobs.find((job) => job.id === Number(target.slice(1)))?.pid ?? null;
      if (pid === null) {
        usage(io, "kill", `${target}: no such job`, 1);
        status = 1;
        continue;
      }
    } else if (/^-?\d+$/.test(target)) {
      pid = Number(target);
    } else {
      usage(io, "kill", `${target}: arguments must be process or job IDs`, 1);
      status = 1;
      continue;
    }
    try {
      if (signal !== "0") {
        runtime().processes.kill(pid, signal);
      } else if (!shell.process.jobs.some((job) => job.pid === pid && job.status === null)) {
        throw new Error("No such process");
      }
    } catch (error) {
      usage(
        io,
        "kill",
        `(${pid}) - ${errorText(error) === "ESRCH" ? "No such process" : errorText(error)}`,
        1,
      );
      status = 1;
    }
  }
  return status;
};

const jobs: Builtin = (shell, _args, io) => {
  for (const job of shell.process.jobs) {
    const state =
      job.status === null ? "Running" : `Done${job.status === 0 ? "" : `(${job.status})`}`;
    io.out(`[${job.id}]  ${state.padEnd(22)} ${job.command}\n`);
  }
  shell.process.jobs = shell.process.jobs.filter((job) => job.status === null);
  return 0;
};

const history: Builtin = (shell, args, io) => {
  if (args[0] === "-c") {
    shell.process.history.length = 0;
    return 0;
  }
  const list = shell.process.history;
  const count = args[0] !== undefined && /^\d+$/.test(args[0]) ? Number(args[0]) : list.length;
  const start = Math.max(0, list.length - count);
  for (let i = start; i < list.length; i++) {
    io.out(`${String(i + 1).padStart(5)}  ${list[i]}\n`);
  }
  return 0;
};

const let_: Builtin = (shell, args, io) => {
  if (args.length === 0) {
    return usage(io, "let", "expression expected", 1);
  }
  let value = 0;
  for (const arg of args) {
    value = arithmetic(shell.expandContext(), arg);
  }
  return value === 0 ? 1 : 0;
};

const getopts: Builtin = (shell, args, io) => {
  const [spec, name, ...given] = args;
  if (spec === undefined || name === undefined) {
    return usage(io, "getopts", "usage: getopts optstring name [arg ...]");
  }
  const params = given.length > 0 ? given : shell.positional;
  const silent = spec.startsWith(":");
  const letters = silent ? spec.slice(1) : spec;
  let index = Number(shell.get("OPTIND") ?? "1") || 1;
  let offset = Number(shell.get("__GETOPTS_OFFSET") ?? "1") || 1;
  const finish = (): number => {
    shell.set(name, "?");
    shell.set("OPTIND", String(index));
    shell.set("__GETOPTS_OFFSET", "1");
    shell.unset("OPTARG");
    return 1;
  };
  const arg = params[index - 1];
  if (arg === undefined || arg === "-" || !arg.startsWith("-")) {
    return finish();
  }
  if (arg === "--") {
    index++;
    return finish();
  }
  const letter = arg[offset];
  const at = letters.indexOf(letter);
  let nextOffset = offset + 1;
  const advance = (): void => {
    if (nextOffset >= arg.length) {
      index++;
      offset = 1;
    } else {
      offset = nextOffset;
    }
  };
  if (at < 0 || letter === ":") {
    if (silent) {
      shell.set("OPTARG", letter);
    } else {
      io.err(`${shell.arg0}: illegal option -- ${letter}\n`);
      shell.unset("OPTARG");
    }
    shell.set(name, "?");
    advance();
  } else if (letters[at + 1] === ":") {
    let value: string | undefined;
    if (nextOffset < arg.length) {
      value = arg.slice(nextOffset);
      index++;
    } else {
      value = params[index];
      index += 2;
    }
    offset = 1;
    nextOffset = 0;
    if (value === undefined) {
      if (silent) {
        shell.set(name, ":");
        shell.set("OPTARG", letter);
      } else {
        io.err(`${shell.arg0}: option requires an argument -- ${letter}\n`);
        shell.set(name, "?");
      }
    } else {
      shell.set(name, letter);
      shell.set("OPTARG", value);
    }
  } else {
    shell.set(name, letter);
    shell.unset("OPTARG");
    advance();
  }
  shell.set("OPTIND", String(index));
  shell.set("__GETOPTS_OFFSET", String(offset));
  return 0;
};

const testBuiltin: Builtin = (shell, args, io) => {
  try {
    return evaluateTest(args, shell.cwd, (variable) => shell.get(variable)) ? 0 : 1;
  } catch (error) {
    io.err(`sh: test: ${(error as Error).message}\n`);
    return 2;
  }
};

const bracket: Builtin = (shell, args, io) => {
  if (args[args.length - 1] !== "]") {
    io.err("sh: [: missing `]'\n");
    return 2;
  }
  try {
    return evaluateTest(args.slice(0, -1), shell.cwd, (variable) => shell.get(variable)) ? 0 : 1;
  } catch (error) {
    io.err(`sh: [: ${(error as Error).message}\n`);
    return 2;
  }
};

const umask: Builtin = (_shell, args, io) => {
  if (args.length === 0) {
    io.out("0022\n");
  } else if (args[0] === "-S") {
    io.out("u=rwx,g=rx,o=rx\n");
  }
  return 0;
};

const ulimit: Builtin = (_shell, args, io) => {
  if (args.every((arg) => arg.startsWith("-"))) {
    io.out("unlimited\n");
  }
  return 0;
};

const getconf: Builtin = (shell, args, io) => {
  const values: Record<string, string> = {
    ARG_MAX: "2097152",
    PAGESIZE: "4096",
    PAGE_SIZE: "4096",
    _NPROCESSORS_ONLN: String(
      (globalThis.navigator?.hardwareConcurrency as number | undefined) ?? 1,
    ),
    _NPROCESSORS_CONF: String(
      (globalThis.navigator?.hardwareConcurrency as number | undefined) ?? 1,
    ),
    PATH: shell.get("PATH") ?? "/bin:/usr/bin",
    LONG_BIT: "64",
    CLK_TCK: "100",
    NAME_MAX: "255",
    PATH_MAX: "4096",
  };
  const name = args[0];
  if (name === undefined) {
    return usage(io, "getconf", "usage: getconf NAME", 1);
  }
  const value = values[name];
  if (value === undefined) {
    io.err(`getconf: ${name}: not supported\n`);
    return 1;
  }
  io.out(`${value}\n`);
  return 0;
};

const clear: Builtin = (_shell, _args, io) => {
  io.out("\x1b[H\x1b[2J\x1b[3J");
  return 0;
};

const hash: Builtin = () => 0;

const times: Builtin = (_shell, _args, io) => {
  io.out("0m0.000s 0m0.000s\n0m0.000s 0m0.000s\n");
  return 0;
};

const disown: Builtin = (shell) => {
  shell.process.jobs = [];
  return 0;
};

const notSupported =
  (name: string): Builtin =>
  (_shell, _args, io) =>
    usage(io, name, "not supported", 1);

/** The shell builtins by name. */
export const BUILTINS: Record<string, Builtin> = {
  cd,
  pwd,
  exit,
  return: returnBuiltin,
  break: loopControl("break"),
  continue: loopControl("continue"),
  export: exportBuiltin,
  readonly: readonlyBuiltin,
  local,
  declare,
  typeset: declare,
  unset,
  set,
  shift,
  read,
  source,
  ".": source,
  eval: evalBuiltin,
  exec: execBuiltin,
  alias,
  unalias,
  type,
  which,
  command,
  builtin: builtinBuiltin,
  trap,
  wait,
  kill,
  jobs,
  history,
  let: let_,
  getopts,
  test: testBuiltin,
  "[": bracket,
  true: () => 0,
  false: () => 1,
  ":": () => 0,
  umask,
  ulimit,
  getconf,
  clear,
  hash,
  times,
  disown,
  fg: notSupported("fg"),
  bg: notSupported("bg"),
  suspend: notSupported("suspend"),
  ps: (_shell, _args, io) => usage(io, "ps", "not available: webnode has no process listing", 1),
};
