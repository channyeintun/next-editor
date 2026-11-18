// The file, string and integer tests of `test`, `[` and `[[ … ]]`, and the
// expression parser `test` and `[` use (the builtins live in builtins.ts).
import {
  R_OK,
  S_IFBLK,
  S_IFCHR,
  S_IFIFO,
  S_IFMT,
  S_IFSOCK,
  W_OK,
  X_OK,
} from "../../../../kernel/vfs/types";
import { runtime } from "../../../runtime";
import { absolutePath, isDir, isFile, sameFile, tryStat } from "./util";

const UNARY = new Set([
  "-e",
  "-a",
  "-f",
  "-d",
  "-L",
  "-h",
  "-r",
  "-w",
  "-x",
  "-s",
  "-p",
  "-S",
  "-b",
  "-c",
  "-t",
  "-z",
  "-n",
  "-v",
  "-O",
  "-G",
  "-g",
  "-u",
  "-k",
]);
const BINARY = new Set([
  "=",
  "==",
  "!=",
  "<",
  ">",
  "-eq",
  "-ne",
  "-lt",
  "-le",
  "-gt",
  "-ge",
  "-nt",
  "-ot",
  "-ef",
]);

function accessible(path: string, mode: number): boolean {
  try {
    runtime().fs.access(path, mode);
    return true;
  } catch {
    return false;
  }
}

/** A unary test: true/false, or an error message. */
export function unaryTest(
  op: string,
  arg: string,
  cwd: string,
  getVar: (name: string) => string | undefined,
): boolean | string {
  if (op === "-z") {
    return arg === "";
  }
  if (op === "-n") {
    return arg !== "";
  }
  if (op === "-v") {
    return getVar(arg) !== undefined;
  }
  if (op === "-t") {
    if (!/^\d+$/.test(arg)) {
      return `${arg}: integer expression expected`;
    }
    try {
      return runtime().tty.isatty(Number(arg));
    } catch {
      return false;
    }
  }
  if (!UNARY.has(op)) {
    return `${op}: unary operator expected`;
  }
  if (arg === "") {
    return false;
  }
  const path = absolutePath(cwd, arg);
  if (op === "-L" || op === "-h") {
    const stat = tryStat(path, false);
    return stat !== null && (stat.mode & S_IFMT) === 0o120000;
  }
  const stat = tryStat(path, true);
  if (!stat) {
    return false;
  }
  switch (op) {
    case "-e":
    case "-a":
    case "-O":
    case "-G":
      return true;
    case "-f":
      return isFile(stat);
    case "-d":
      return isDir(stat);
    case "-s":
      return stat.size > 0;
    case "-p":
      return (stat.mode & S_IFMT) === S_IFIFO;
    case "-S":
      return (stat.mode & S_IFMT) === S_IFSOCK;
    case "-b":
      return (stat.mode & S_IFMT) === S_IFBLK;
    case "-c":
      return (stat.mode & S_IFMT) === S_IFCHR;
    case "-r":
      return accessible(path, R_OK);
    case "-w":
      return accessible(path, W_OK);
    case "-x":
      return accessible(path, X_OK);
    case "-u":
      return (stat.mode & 0o4000) !== 0;
    case "-g":
      return (stat.mode & 0o2000) !== 0;
    case "-k":
      return (stat.mode & 0o1000) !== 0;
  }
  return false;
}

function integer(text: string): number | null {
  const trimmed = text.trim();
  return /^[+-]?\d+$/.test(trimmed) ? Number(trimmed) : null;
}

/** A binary test: true/false, or an error message. */
export function binaryTest(op: string, left: string, right: string, cwd: string): boolean | string {
  switch (op) {
    case "=":
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    case "<":
      return left < right;
    case ">":
      return left > right;
    case "-eq":
    case "-ne":
    case "-lt":
    case "-le":
    case "-gt":
    case "-ge": {
      const a = integer(left);
      const b = integer(right);
      if (a === null) {
        return `${left}: integer expression expected`;
      }
      if (b === null) {
        return `${right}: integer expression expected`;
      }
      return {
        "-eq": a === b,
        "-ne": a !== b,
        "-lt": a < b,
        "-le": a <= b,
        "-gt": a > b,
        "-ge": a >= b,
      }[op];
    }
    case "-nt":
    case "-ot": {
      const a = tryStat(absolutePath(cwd, left));
      const b = tryStat(absolutePath(cwd, right));
      if (op === "-nt") {
        return a !== null && (b === null || a.mtimeMs > b.mtimeMs);
      }
      return b !== null && (a === null || a.mtimeMs < b.mtimeMs);
    }
    case "-ef": {
      const a = tryStat(absolutePath(cwd, left));
      const b = tryStat(absolutePath(cwd, right));
      return a !== null && b !== null && sameFile(a, b);
    }
  }
  return `${op}: binary operator expected`;
}

class TestParser {
  private pos = 0;
  private readonly args: string[];
  private readonly cwd: string;
  private readonly getVar: (name: string) => string | undefined;

  constructor(args: string[], cwd: string, getVar: (name: string) => string | undefined) {
    this.args = args;
    this.cwd = cwd;
    this.getVar = getVar;
  }

  run(): boolean {
    if (this.args.length === 0) {
      return false;
    }
    const value = this.or();
    if (this.pos < this.args.length) {
      throw new Error(`${this.args[this.pos]}: unexpected argument`);
    }
    return value;
  }

  private or(): boolean {
    let value = this.and();
    while (this.args[this.pos] === "-o") {
      this.pos++;
      const right = this.and();
      value = value || right;
    }
    return value;
  }

  private and(): boolean {
    let value = this.not();
    while (this.args[this.pos] === "-a") {
      this.pos++;
      const right = this.not();
      value = value && right;
    }
    return value;
  }

  private not(): boolean {
    if (this.args[this.pos] === "!" && this.pos + 1 < this.args.length) {
      this.pos++;
      return !this.not();
    }
    return this.primary();
  }

  private primary(): boolean {
    const args = this.args;
    const token = args[this.pos];
    if (token === undefined) {
      throw new Error("argument expected");
    }
    if (this.pos + 2 < args.length && BINARY.has(args[this.pos + 1])) {
      const result = binaryTest(args[this.pos + 1], token, args[this.pos + 2], this.cwd);
      this.pos += 3;
      if (typeof result === "string") {
        throw new Error(result);
      }
      return result;
    }
    if (token === "(") {
      this.pos++;
      const value = this.or();
      if (args[this.pos] !== ")") {
        throw new Error("`)' expected");
      }
      this.pos++;
      return value;
    }
    if (UNARY.has(token) && this.pos + 1 < args.length) {
      const result = unaryTest(token, args[this.pos + 1], this.cwd, this.getVar);
      this.pos += 2;
      if (typeof result === "string") {
        throw new Error(result);
      }
      return result;
    }
    this.pos++;
    return token !== "";
  }
}

/** Evaluates `test` arguments; throws an `Error` for a usage error. */
export function evaluateTest(
  args: string[],
  cwd: string,
  getVar: (name: string) => string | undefined,
): boolean {
  return new TestParser(args, cwd, getVar).run();
}
