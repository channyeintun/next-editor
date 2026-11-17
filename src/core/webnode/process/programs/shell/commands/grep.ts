// `grep` with -i -v -n -c -l -L -r/-R -E -F -G -q -w -x -o -h -H -s -e -f -m
// -A -B -C and --include / --exclude / --exclude-dir; matches are coloured
// when standard output is a terminal. Each file is matched as it is read and
// standard input line by line as it arrives, so `server | grep ready` prints
// at once and a tree is never held in memory whole.
import { runtime } from "../../../runtime";
import type { Command } from "../context";
import { matchPattern } from "../pattern";
import { posixToJs } from "./regex";
import { decodeText, inputLines, writeText } from "./lines";
import { errorText, isDir, options, tryStat } from "./util";

/** Options that may be given more than once; the option parser keeps only the last. */
interface Lists {
  e: string[];
  include: string[];
  exclude: string[];
  excludeDir: string[];
}

const LIST_OPTIONS: Record<string, keyof Lists> = {
  regexp: "e",
  include: "include",
  exclude: "exclude",
  "exclude-dir": "excludeDir",
};

/** Rescans `args` for every value of the options grep takes more than once. */
function collectLists(args: string[]): Lists {
  const lists: Lists = { e: [], include: [], exclude: [], excludeDir: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      const list = LIST_OPTIONS[name];
      if (list) {
        const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
        if (value !== undefined) {
          lists[list].push(value);
        }
      } else if (eq < 0 && /^(max-count|(after-|before-)?context)$/.test(name)) {
        i++;
      }
      continue;
    }
    if (!arg.startsWith("-") || arg.length < 2) {
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      if ("efmABC".includes(arg[j])) {
        const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
        if (arg[j] === "e" && value !== undefined) {
          lists.e.push(value);
        }
        break;
      }
    }
  }
  return lists;
}

/** `grep`. */
export const grep: Command = async (ctx, args) => {
  const parsed = options(ctx, args, {
    flags: "ivncLlrRqswxoEFGhHIaz",
    values: "efmABC",
    long: {
      "ignore-case": "i",
      "invert-match": "v",
      "line-number": "n",
      count: "c",
      "files-with-matches": "l",
      "files-without-match": "L",
      recursive: "r",
      quiet: "q",
      silent: "q",
      "word-regexp": "w",
      "line-regexp": "x",
      "only-matching": "o",
      "extended-regexp": "E",
      "fixed-strings": "F",
      "no-filename": "h",
      "with-filename": "H",
      "no-messages": "s",
      "color=": "color",
      colour: "color",
      color: "color",
      "regexp=": "e",
      "include=": "include",
      "exclude=": "exclude",
      "exclude-dir=": "exclude-dir",
      "max-count=": "m",
      "after-context=": "A",
      "before-context=": "B",
      "context=": "C",
    },
  });
  if (!parsed) {
    return 2;
  }
  const f = (flag: string): boolean => parsed.flags.has(flag);
  const number = (flag: string): number | null => {
    const value = parsed.flags.get(flag);
    return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null;
  };
  for (const flag of ["A", "B", "C", "m"]) {
    if (f(flag) && number(flag) === null) {
      ctx.io.err(
        `grep: ${parsed.flags.get(flag)}: invalid ${flag === "m" ? "max count" : "context length argument"}\n`,
      );
      return 2;
    }
  }
  const operands = [...parsed.operands];
  const lists = collectLists(args);
  const patterns = lists.e;
  const patternFile = parsed.flags.get("f");
  if (typeof patternFile === "string") {
    try {
      patterns.push(
        ...decodeText(runtime().fs.readFile(ctx.resolve(patternFile)))
          .split("\n")
          .filter((line) => line !== ""),
      );
    } catch (error) {
      ctx.io.err(`grep: ${patternFile}: ${errorText(error)}\n`);
      return 2;
    }
  }
  if (patterns.length === 0) {
    const first = operands.shift();
    if (first === undefined) {
      ctx.io.err("Usage: grep [OPTION]... PATTERNS [FILE]...\n");
      return 2;
    }
    patterns.push(...first.split("\n"));
  }
  const mode = f("F") ? "fixed" : f("E") ? "extended" : "basic";
  let source = patterns.map((pattern) => `(?:${posixToJs(pattern, mode)})`).join("|");
  if (f("w")) {
    source = `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])`;
  }
  if (f("x")) {
    source = `^(?:${source})$`;
  }
  let regex: RegExp;
  try {
    regex = new RegExp(source, f("i") ? "gi" : "g");
  } catch {
    ctx.io.err(`grep: invalid regular expression: ${patterns.join(" ")}\n`);
    return 2;
  }

  const recursive = f("r") || f("R");
  const files = operands.length > 0 ? operands : recursive ? ["."] : ["-"];
  // Names are shown for more than one operand or a tree, whether or not each
  // operand could be read.
  const withNames = f("H") || (!f("h") && (files.length > 1 || recursive));
  const color = ctx.io.isTty(1) && parsed.flags.get("color") !== "never";
  const maxCount = number("m") ?? Infinity;
  const invert = f("v");
  const summary = f("q") || f("l") || f("L") || f("c");
  const contextual = !summary && !f("o");
  const after = contextual ? (number("A") ?? number("C") ?? 0) : 0;
  const before = contextual ? (number("B") ?? number("C") ?? 0) : 0;
  const byName = (globs: string[], name: string): boolean => {
    const base = name.slice(name.replace(/\/+$/, "").lastIndexOf("/") + 1);
    return globs.some((glob) => matchPattern(glob, base));
  };
  const skipFile = (name: string): boolean =>
    (lists.include.length > 0 && !byName(lists.include, name)) || byName(lists.exclude, name);

  let status = 1;
  let hadError = false;
  /** Something was printed, so the next context group needs a `--` before it. */
  let printedGroup = false;
  /** Set by -q on the first match: stop everything. */
  let quit = false;

  /** Matches one input as its lines arrive; false once output is gone or -q matched. */
  const search = async (
    name: string,
    batches: AsyncIterable<{ lines: string[] }> | Iterable<{ lines: string[] }>,
  ): Promise<boolean> => {
    let count = 0;
    let lineNumber = 0;
    let lastShown = 0;
    let afterLeft = 0;
    const held: { line: string; at: number }[] = [];
    const prefix = (at: number, separator: string): string => {
      let p = "";
      if (withNames) {
        p += color ? `\x1b[35m${name}\x1b[36m${separator}\x1b[0m` : `${name}${separator}`;
      }
      if (f("n")) {
        p += color ? `\x1b[32m${at}\x1b[36m${separator}\x1b[0m` : `${at}${separator}`;
      }
      return p;
    };
    const show = (line: string, at: number, separator: string): string => {
      let out = "";
      if ((before > 0 || after > 0) && printedGroup && at > lastShown + 1) {
        out += color ? "\x1b[36m--\x1b[0m\n" : "--\n";
      }
      printedGroup = true;
      lastShown = at;
      return `${out}${prefix(at, separator)}${line}\n`;
    };
    for await (const batch of batches) {
      let out = "";
      let done = false;
      for (const line of batch.lines) {
        lineNumber++;
        regex.lastIndex = 0;
        const selected = count < maxCount && regex.test(line) !== invert;
        if (!selected) {
          if (afterLeft > 0) {
            afterLeft--;
            out += show(line, lineNumber, "-");
          } else if (count >= maxCount) {
            done = true;
            break;
          } else if (before > 0) {
            held.push({ line, at: lineNumber });
            if (held.length > before) {
              held.shift();
            }
          }
          continue;
        }
        count++;
        if (summary) {
          // These need one match (or the count) only.
          if (f("q")) {
            quit = true;
          }
          if (f("q") || f("l") || f("L") || count >= maxCount) {
            done = true;
            break;
          }
          continue;
        }
        for (const context of held) {
          out += show(context.line, context.at, "-");
        }
        held.length = 0;
        afterLeft = after;
        if (f("o") && !invert) {
          regex.lastIndex = 0;
          for (const match of line.matchAll(regex)) {
            if (match[0] !== "") {
              out += `${prefix(lineNumber, ":")}${color ? `\x1b[01;31m${match[0]}\x1b[0m` : match[0]}\n`;
            }
          }
          continue;
        }
        const shown =
          color && !invert ? line.replace(regex, (m) => (m ? `\x1b[01;31m${m}\x1b[0m` : m)) : line;
        out += show(shown, lineNumber, ":");
      }
      if (!writeText(ctx, out)) {
        return false;
      }
      if (done || (count >= maxCount && afterLeft === 0)) {
        break;
      }
    }
    if (count > 0) {
      status = 0;
    }
    if (quit) {
      return false;
    }
    let out = "";
    if (f("l")) {
      out = count > 0 ? `${name}\n` : "";
    } else if (f("L")) {
      out = count === 0 ? `${name}\n` : "";
    } else if (f("c")) {
      out = `${withNames ? `${name}:` : ""}${count}\n`;
    }
    return writeText(ctx, out);
  };

  /** Searches one file; false to stop. A tree skips binary files. */
  const searchFile = async (path: string, label: string, inTree: boolean): Promise<boolean> => {
    let data: Uint8Array;
    try {
      data = runtime().fs.readFile(path);
    } catch (error) {
      if (!f("s")) {
        ctx.io.err(`grep: ${label}: ${errorText(error)}\n`);
      }
      hadError = true;
      return true;
    }
    if (inTree && data.subarray(0, 8000).includes(0)) {
      return true;
    }
    const complete = data.length > 0 && data[data.length - 1] === 10;
    const text = decodeText(complete ? data.subarray(0, data.length - 1) : data);
    return search(label, data.length === 0 ? [] : [{ lines: text.split("\n") }]);
  };

  /** Walks a directory, matching each file as it is reached; false to stop. */
  const walk = async (path: string, label: string): Promise<boolean> => {
    let entries;
    try {
      entries = runtime().fs.readdir(path);
    } catch (error) {
      if (!f("s")) {
        ctx.io.err(`grep: ${label}: ${errorText(error)}\n`);
      }
      hadError = true;
      return true;
    }
    for (const entry of entries) {
      if (entry.type === "symlink") {
        continue;
      }
      const childPath = `${path === "/" ? "" : path}/${entry.name}`;
      const childLabel = label === "." ? entry.name : `${label.replace(/\/$/, "")}/${entry.name}`;
      const stat = tryStat(childPath);
      if (!stat) {
        continue;
      }
      if (isDir(stat)) {
        if (!byName(lists.excludeDir, entry.name) && !(await walk(childPath, childLabel))) {
          return false;
        }
        continue;
      }
      if (!skipFile(entry.name) && !(await searchFile(childPath, childLabel, true))) {
        return false;
      }
    }
    return true;
  };

  for (const file of files) {
    let going: boolean;
    if (file === "-") {
      going = await search(
        "(standard input)",
        (async function* () {
          for await (const batch of inputLines(ctx, ["-"])) {
            if ("lines" in batch) {
              yield batch;
            }
          }
        })(),
      );
    } else {
      const path = ctx.resolve(file);
      const stat = tryStat(path);
      if (!stat) {
        if (!f("s")) {
          ctx.io.err(`grep: ${file}: No such file or directory\n`);
        }
        hadError = true;
        continue;
      }
      if (isDir(stat)) {
        if (recursive) {
          going = await walk(path, file);
        } else {
          if (!f("s")) {
            ctx.io.err(`grep: ${file}: Is a directory\n`);
          }
          hadError = true;
          continue;
        }
      } else if (skipFile(file)) {
        continue;
      } else {
        going = await searchFile(path, file, false);
      }
    }
    if (!going) {
      break;
    }
  }
  if (quit) {
    return 0;
  }
  if (hadError) {
    return f("q") && status === 0 ? 0 : 2;
  }
  return status;
};
