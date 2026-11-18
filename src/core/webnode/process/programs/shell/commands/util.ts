// Helpers shared by the built-in file and text commands: option parsing,
// the path an operand names, error messages in coreutils wording, and reading
// the named files or standard input.
import { toSystemErrorRecord } from "../../../../errors";
import type { StatData } from "../../../../kernel/vfs/types";
import { O_RDONLY, S_IFDIR, S_IFLNK, S_IFMT, S_IFREG } from "../../../../kernel/vfs/types";
import { runtime } from "../../../runtime";
import type { CommandContext } from "../context";
import { ReadInterrupted, closeFd, concatBytes, descriptorOf } from "../io";

/**
 * The path the filesystem gets for a command's operand. An absolute path
 * passes as it is written and a relative one is joined to `cwd`, nothing in
 * it resolved here: the filesystem resolves `..` after the symbolic links
 * before it, checks search permission on every directory the path names, and
 * gives a trailing `/` its meaning. An empty operand stays empty, which names
 * no file (ENOENT) and never `cwd`.
 */
export function absolutePath(cwd: string, path: string): string {
  if (path === "" || path.startsWith("/")) {
    return path;
  }
  return cwd.endsWith("/") ? `${cwd}${path}` : `${cwd}/${path}`;
}

/** True when two stat records are of one file (GNU's `SAME_INODE`). */
export function sameFile(a: StatData, b: StatData): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * `path` against `cwd` with `.`, `..` and `//` resolved in the text alone:
 * the logical name bash's `cd` gives the working directory, where `..` leaves
 * a linked directory by the way it was entered and an empty path is `cwd`.
 * It is not what a file operand names (see `absolutePath`).
 */
export function resolvePath(cwd: string, path: string): string {
  const absolute = path.startsWith("/") ? path : `${cwd}/${path}`;
  const out: string[] = [];
  for (const part of absolute.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      out.pop();
    } else {
      out.push(part);
    }
  }
  return `/${out.join("/")}`;
}

/** The last component of a path, as `basename` prints it. */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") {
    return path.startsWith("/") ? "/" : "";
  }
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/**
 * The target GNU cp and mv name for `source` copied or moved into the
 * directory `dest`, as gnulib's file_name_concat builds it: `dest` without its
 * trailing slashes, a slash, and the source's last component (`ro/` + `out` is
 * `ro/out`, `.` + `ro/in` is `./in`).
 */
export function targetInDirectory(dest: string, source: string): string {
  const directory = dest.replace(/(?<=[^/])\/+$/, "");
  const separator = directory.endsWith("/") ? "" : "/";
  return `${directory}${separator}${baseName(source)}`;
}

/** The directory part of a path, as `dirname` prints it. */
export function dirName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") {
    return path.startsWith("/") ? "/" : ".";
  }
  const slash = trimmed.lastIndexOf("/");
  if (slash < 0) {
    return ".";
  }
  const dir = trimmed.slice(0, slash).replace(/\/+$/, "");
  return dir === "" ? "/" : dir;
}

const MESSAGES: Record<string, string> = {
  ENOENT: "No such file or directory",
  EEXIST: "File exists",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  EACCES: "Permission denied",
  EPERM: "Operation not permitted",
  ENOTEMPTY: "Directory not empty",
  EINVAL: "Invalid argument",
  ELOOP: "Too many levels of symbolic links",
  EXDEV: "Invalid cross-device link",
  EBADF: "Bad file descriptor",
  EBUSY: "Device or resource busy",
  ENOSPC: "No space left on device",
  ENAMETOOLONG: "File name too long",
  EROFS: "Read-only file system",
  EPIPE: "Broken pipe",
};

/** The coreutils description of an errno code (`ENOTDIR`: `Not a directory`). */
export function errnoText(code: string): string {
  return MESSAGES[code] ?? code;
}

/** The coreutils description of a failed system call (`No such file or directory`). */
export function errorText(error: unknown): string {
  const record = toSystemErrorRecord(error);
  if (record) {
    return errnoText(record.code);
  }
  return error instanceof Error ? error.message : String(error);
}

/** What a shell reads as more than itself, and the colon that ends a name in a message. */
const SHELL_SPECIAL = /[ !"$&'()*;<=>?[\\^`|:]/;
/** What keeps a name with a `'` in it out of double quotes. */
const NOT_IN_DOUBLE_QUOTES = /[!"$&()*;<=>?[\\^`|]/;

/** True for a control character's code (tab and newline among them). */
function isControl(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

/** A control character as bash's `$'…'` writes it. */
function controlEscape(code: number): string {
  const named: Record<number, string> = {
    7: "a",
    8: "b",
    9: "t",
    10: "n",
    11: "v",
    12: "f",
    13: "r",
  };
  return `\\${named[code] ?? code.toString(8).padStart(3, "0")}`;
}

/**
 * A file name as GNU's `quotef` puts it before a colon (`cat: 'a b': …`): as
 * it is, or quoted the way a shell would take it back when it is empty or has
 * a character a shell reads specially.
 */
export function quoteName(name: string): string {
  const control = Array.from(name).some((ch) => isControl(ch.charCodeAt(0)));
  const plain =
    name !== "" &&
    !control &&
    !SHELL_SPECIAL.test(name) &&
    !/^[#~]/.test(name) &&
    name !== "{" &&
    name !== "}";
  if (plain) {
    return name;
  }
  if (name.includes("'") && !control && !NOT_IN_DOUBLE_QUOTES.test(name)) {
    return `"${name}"`;
  }
  let out = "'";
  let escaping = false;
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (isControl(code) !== escaping) {
      out += escaping ? "''" : "'$'";
      escaping = !escaping;
    }
    out += escaping ? controlEscape(code) : ch === "'" ? "'\\''" : ch;
  }
  return `${out}'`;
}

/** Prints `name: message` to standard error and returns 1. */
export function fail(ctx: CommandContext, message: string, status = 1): number {
  ctx.io.err(`${ctx.name}: ${message}\n`);
  return status;
}

export interface ParsedOptions {
  /** Flag letter (or long name) → value, or true for a flag without one. */
  flags: Map<string, string | true>;
  operands: string[];
}

export interface OptionSpec {
  /** Single-letter flags without a value. */
  flags: string;
  /** Single-letter options that take a value. */
  values?: string;
  /** Long option → the short letter (or its own name) it stands for; a trailing `=` takes a value. */
  long?: Record<string, string>;
}

/**
 * Parses `args` POSIX-style: combined flags (`-la`), values attached or
 * separate (`-n5`, `-n 5`), `--` and long options. Throws an `Error` with
 * coreutils wording for an unknown option.
 */
export function parseOptions(args: string[], spec: OptionSpec): ParsedOptions {
  const flags = new Map<string, string | true>();
  const operands: string[] = [];
  const values = spec.values ?? "";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--") && spec.long) {
      const eq = arg.indexOf("=");
      const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      const takesValue = `${name}=` in spec.long && (eq >= 0 || !(name in spec.long));
      const target = spec.long[name] ?? spec.long[`${name}=`];
      if (target === undefined) {
        throw new Error(`unrecognized option '${arg}'`);
      }
      if (takesValue) {
        let value = eq < 0 ? args[++i] : arg.slice(eq + 1);
        if (value === undefined) {
          throw new Error(`option '--${name}' requires an argument`);
        }
        value = String(value);
        flags.set(target, value);
      } else {
        flags.set(target, true);
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const letter = arg[j];
        if (values.includes(letter)) {
          const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
          if (value === undefined) {
            throw new Error(`option requires an argument -- '${letter}'`);
          }
          flags.set(letter, value);
          break;
        }
        if (!spec.flags.includes(letter)) {
          throw new Error(`invalid option -- '${letter}'`);
        }
        flags.set(letter, true);
      }
      continue;
    }
    operands.push(arg);
  }
  return { flags, operands };
}

/** Parses options, printing the error and returning null on failure. */
export function options(
  ctx: CommandContext,
  args: string[],
  spec: OptionSpec,
): ParsedOptions | null {
  try {
    return parseOptions(args, spec);
  } catch (error) {
    ctx.io.err(`${ctx.name}: ${(error as Error).message}\n`);
    return null;
  }
}

/** True when the stat record is a directory. */
export function isDir(stat: StatData): boolean {
  return (stat.mode & S_IFMT) === S_IFDIR;
}

/** True when the stat record is a regular file. */
export function isFile(stat: StatData): boolean {
  return (stat.mode & S_IFMT) === S_IFREG;
}

/** True when the stat record is a symbolic link. */
export function isLink(stat: StatData): boolean {
  return (stat.mode & S_IFMT) === S_IFLNK;
}

/** stat that returns the error it failed with instead of throwing. */
export function statOrError(path: string, follow = true): StatData | { error: unknown } {
  try {
    return runtime().fs.stat(path, follow);
  } catch (error) {
    return { error };
  }
}

/** stat that returns null instead of throwing. */
export function tryStat(path: string, follow = true): StatData | null {
  try {
    return runtime().fs.stat(path, follow);
  } catch {
    return null;
  }
}

/** An input a command could not read. */
export interface InputError {
  name: string;
  /** Why, in coreutils' words (`No such file or directory`). */
  error: string;
}

/** `file` could not be read because of `error`. */
export function inputError(file: string, error: unknown): InputError {
  return { name: file, error: errorText(error) };
}

/**
 * True when `input` is standard input (`-`) that could not be read because
 * it is closed (`<&-`). Each GNU tool reports that in words of its own, and
 * most report it again when they close standard input at their end.
 */
export function closedStandardInput(input: InputError): boolean {
  return input.name === "-" && input.error === errnoText("EBADF");
}

/** `file` is a directory, which no command here reads as text. */
export function directoryInput(file: string): InputError {
  return { name: file, error: errnoText("EISDIR") };
}

/**
 * The bytes of one input as they arrive: standard input (`-`) chunk by
 * chunk, a file whole, and an operand that is not a regular file (a device
 * such as /dev/tty, whose bytes come when they are typed and may never end)
 * chunk by chunk too, read as standard input is, so that the shell goes on
 * running meanwhile. An input that cannot be read yields an `InputError`.
 */
export async function* inputChunks(
  ctx: CommandContext,
  file: string,
): AsyncGenerator<Uint8Array | InputError> {
  // `/dev/stdin` and `/dev/fd/N` are the command's own fds, which the shell
  // knows and the kernel does not (it would open the shell's). Such a name
  // for a closed fd (`/dev/stdin` with `<&-`) is not there, as on Linux;
  // `-` reads standard input, closed or not.
  const named = file === "-" ? 0 : descriptorOf(file);
  const real = named === null || file === "-" ? null : ctx.io.fd(named);
  if (named !== null && file !== "-" && real === null) {
    yield { name: file, error: errnoText("ENOENT") };
    return;
  }
  if (named !== null) {
    for (;;) {
      let chunk: Uint8Array;
      try {
        chunk = await (real === null ? ctx.io.readChunk() : ctx.io.readFrom(real));
      } catch (error) {
        if (error instanceof ReadInterrupted) {
          throw error;
        }
        yield inputError(file, error);
        return;
      }
      if (chunk.length === 0) {
        return;
      }
      yield chunk;
    }
  }
  try {
    const path = absolutePath(ctx.cwd, file);
    const stat = runtime().fs.stat(path, true);
    if (isDir(stat)) {
      yield directoryInput(file);
      return;
    }
    if (isFile(stat)) {
      yield runtime().fs.readFile(path);
      return;
    }
    const fd = runtime().fs.open(path, O_RDONLY, 0);
    try {
      for (;;) {
        const chunk = await ctx.io.readFrom(fd);
        if (chunk.length === 0) {
          return;
        }
        yield chunk;
      }
    } finally {
      closeFd(fd);
    }
  } catch (error) {
    if (error instanceof ReadInterrupted) {
      throw error;
    }
    yield inputError(file, error);
  }
}

/**
 * The bytes of each input: every named file (`-` is standard input) or
 * standard input when there are none. A file that cannot be read is yielded
 * as an `InputError` and skipped.
 */
export async function* inputs(
  ctx: CommandContext,
  files: string[],
): AsyncGenerator<{ name: string; data: Uint8Array } | InputError> {
  if (files.length === 0) {
    files = ["-"];
  }
  for (const file of files) {
    if (file === "-") {
      let data: Uint8Array;
      try {
        data = await ctx.io.readAll();
      } catch (error) {
        if (error instanceof ReadInterrupted) {
          throw error;
        }
        yield inputError(file, error);
        continue;
      }
      yield { name: "-", data };
      continue;
    }
    const chunks: Uint8Array[] = [];
    let failure: InputError | null = null;
    for await (const chunk of inputChunks(ctx, file)) {
      if (chunk instanceof Uint8Array) {
        chunks.push(chunk);
      } else {
        failure = chunk;
      }
    }
    yield failure ?? { name: file, data: chunks.length === 1 ? chunks[0] : concatBytes(chunks) };
  }
}
