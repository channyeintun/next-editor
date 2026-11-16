// `grep` with -i -v -n -c -l -L -r/-R -E -F -G -q -w -x -o -h -H -s -e -f;
// matches are coloured when standard output is a terminal.
import { runtime } from "../../../runtime";
import type { Command } from "../context";
import { decode } from "../io";
import { posixToJs } from "./regex";
import { errorText, isDir, options, tryStat } from "./util";

interface Source {
  name: string;
  text: string;
}

function collectRecursive(path: string, label: string, out: Source[]): void {
  const fs = runtime().fs;
  const stat = tryStat(path);
  if (!stat) {
    return;
  }
  if (isDir(stat)) {
    for (const entry of fs.readdir(path)) {
      if (entry.type === "symlink") {
        continue;
      }
      collectRecursive(
        `${path}/${entry.name}`,
        label === "." && entry.name ? entry.name : `${label.replace(/\/$/, "")}/${entry.name}`,
        out,
      );
    }
    return;
  }
  const data = fs.readFile(path);
  if (data.subarray(0, 8000).includes(0)) {
    return;
  }
  out.push({ name: label, text: decode(data) });
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
      "max-count=": "m",
    },
  });
  if (!parsed) {
    return 2;
  }
  const f = (flag: string): boolean => parsed.flags.has(flag);
  if (f("A") || f("B") || f("C")) {
    ctx.io.err("grep: context lines (-A/-B/-C): not supported\n");
    return 2;
  }
  const operands = [...parsed.operands];
  const patterns: string[] = [];
  // Every -e counts; the option parser keeps only the last, so rescan.
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      break;
    }
    if (arg.startsWith("--regexp=")) {
      patterns.push(arg.slice(9));
      continue;
    }
    if (!arg.startsWith("-") || arg.startsWith("--") || arg.length < 2) {
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      if ("efmABC".includes(arg[j])) {
        const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
        if (arg[j] === "e" && value !== undefined) {
          patterns.push(value);
        }
        break;
      }
    }
  }
  const patternFile = parsed.flags.get("f");
  if (typeof patternFile === "string") {
    try {
      patterns.push(
        ...decode(runtime().fs.readFile(ctx.resolve(patternFile)))
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
  const sources: Source[] = [];
  let status = 1;
  let hadError = false;
  const files = operands.length > 0 ? operands : recursive ? ["."] : ["-"];
  for (const file of files) {
    if (file === "-") {
      sources.push({ name: "(standard input)", text: decode(await ctx.io.readAll()) });
      continue;
    }
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
        collectRecursive(path, file, sources);
      } else if (!f("s")) {
        ctx.io.err(`grep: ${file}: Is a directory\n`);
      }
      continue;
    }
    sources.push({ name: file, text: decode(runtime().fs.readFile(path)) });
  }
  const include = parsed.flags.get("include");
  const exclude = parsed.flags.get("exclude");
  const globMatch = (glob: string, name: string): boolean =>
    new RegExp(
      `^${glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
    ).test(name.slice(name.lastIndexOf("/") + 1));
  const withNames = f("H") || (!f("h") && (sources.length > 1 || recursive));
  const color = ctx.io.isTty(1) && parsed.flags.get("color") !== "never";
  const maxCount =
    typeof parsed.flags.get("m") === "string" ? Number(parsed.flags.get("m")) : Infinity;
  const invert = f("v");
  for (const src of sources) {
    if (
      typeof include === "string" &&
      src.name !== "(standard input)" &&
      !globMatch(include, src.name)
    ) {
      continue;
    }
    if (typeof exclude === "string" && globMatch(exclude, src.name)) {
      continue;
    }
    const lines = src.text.split("\n");
    if (lines[lines.length - 1] === "") {
      lines.pop();
    }
    let count = 0;
    let out = "";
    const prefix = (lineNumber: number): string => {
      let p = "";
      if (withNames) {
        p += color ? `\x1b[35m${src.name}\x1b[36m:\x1b[0m` : `${src.name}:`;
      }
      if (f("n")) {
        p += color ? `\x1b[32m${lineNumber}\x1b[36m:\x1b[0m` : `${lineNumber}:`;
      }
      return p;
    };
    for (let i = 0; i < lines.length && count < maxCount; i++) {
      const line = lines[i];
      regex.lastIndex = 0;
      const matched = regex.test(line);
      if (matched === invert) {
        continue;
      }
      count++;
      if (f("q") || f("l") || f("L") || f("c")) {
        continue;
      }
      if (f("o") && !invert) {
        regex.lastIndex = 0;
        for (const match of line.matchAll(regex)) {
          if (match[0] !== "") {
            out += `${prefix(i + 1)}${color ? `\x1b[01;31m${match[0]}\x1b[0m` : match[0]}\n`;
          }
        }
        continue;
      }
      const shown =
        color && !invert ? line.replace(regex, (m) => (m ? `\x1b[01;31m${m}\x1b[0m` : m)) : line;
      out += `${prefix(i + 1)}${shown}\n`;
    }
    if (count > 0) {
      status = 0;
    }
    if (f("q")) {
      if (count > 0) {
        return 0;
      }
      continue;
    }
    if (f("l")) {
      if (count > 0) {
        out = `${src.name}\n`;
      }
    } else if (f("L")) {
      out = count === 0 ? `${src.name}\n` : "";
    } else if (f("c")) {
      out = `${withNames ? `${src.name}:` : ""}${count}\n`;
    }
    ctx.io.out(out);
    if (ctx.io.broken) {
      break;
    }
  }
  if (hadError) {
    return f("q") && status === 0 ? 0 : 2;
  }
  return status;
};
