// Helpers shared by the built-in file and text commands: option parsing,
// path normalization, error messages in coreutils wording, and reading the
// named files or standard input.
import { toSystemErrorRecord } from "../../../../errors";
import type { StatData } from "../../../../kernel/vfs/types";
import { S_IFDIR, S_IFLNK, S_IFMT, S_IFREG } from "../../../../kernel/vfs/types";
import { runtime } from "../../../runtime";
import type { CommandContext } from "../context";

/** Joins and normalizes `path` against `cwd` (`.`, `..`, `//`). */
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
};

/** The coreutils description of a failed system call (`No such file or directory`). */
export function errorText(error: unknown): string {
  const record = toSystemErrorRecord(error);
  if (record) {
    return MESSAGES[record.code] ?? record.code;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The errno code of a system error, else undefined. */
export function errorCode(error: unknown): string | undefined {
  return toSystemErrorRecord(error)?.code;
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

/** stat that returns null instead of throwing. */
export function tryStat(path: string, follow = true): StatData | null {
  try {
    return runtime().fs.stat(path, follow);
  } catch {
    return null;
  }
}

/**
 * The bytes of each input: every named file (`-` is standard input) or
 * standard input when there are none. A missing file is reported and skipped.
 */
export async function* inputs(
  ctx: CommandContext,
  files: string[],
): AsyncGenerator<{ name: string; data: Uint8Array } | { name: string; error: string }> {
  if (files.length === 0) {
    files = ["-"];
  }
  for (const file of files) {
    if (file === "-") {
      yield { name: "-", data: await ctx.io.readAll() };
      continue;
    }
    const path = ctx.resolve(file);
    try {
      const stat = runtime().fs.stat(path, true);
      if (isDir(stat)) {
        yield { name: file, error: `${file}: Is a directory` };
        continue;
      }
      yield { name: file, data: runtime().fs.readFile(path) };
    } catch (error) {
      yield { name: file, error: `${file}: ${errorText(error)}` };
    }
  }
}
