// `ls` with -l -a -A -1 -R -h -d -r -t -S -F; columns and colours only when
// standard output is a terminal.
import type { StatData } from "../../../../kernel/vfs/types";
import { S_IFMT } from "../../../../kernel/vfs/types";
import { USERNAME } from "../../../platform";
import { runtime } from "../../../runtime";
import type { Command, CommandContext } from "../context";
import { errorText, isDir, isLink, options, resolvePath } from "./util";

interface Entry {
  name: string;
  path: string;
  stat: StatData;
  /** The target's stat for a symlink (null when dangling). */
  target: StatData | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `drwxr-xr-x` for a mode. */
export function modeString(mode: number): string {
  const type = mode & S_IFMT;
  const letter =
    type === 0o040000
      ? "d"
      : type === 0o120000
        ? "l"
        : type === 0o020000
          ? "c"
          : type === 0o060000
            ? "b"
            : type === 0o010000
              ? "p"
              : type === 0o140000
                ? "s"
                : "-";
  let out = letter;
  const chars = "rwxrwxrwx";
  for (let i = 0; i < 9; i++) {
    out += mode & (1 << (8 - i)) ? chars[i] : "-";
  }
  return out;
}

/** `4.0K`-style sizes for `-h`. */
export function humanSize(size: number): string {
  const units = ["", "K", "M", "G", "T"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) {
    return String(size);
  }
  return `${value < 10 ? (Math.ceil(value * 10) / 10).toFixed(1) : String(Math.ceil(value))}${units[unit]}`;
}

function dateString(ms: number): string {
  const date = new Date(ms);
  const month = MONTHS[date.getMonth()];
  const day = String(date.getDate()).padStart(2, " ");
  const sixMonths = 182 * 24 * 3600 * 1000;
  if (Math.abs(Date.now() - ms) > sixMonths) {
    return `${month} ${day}  ${date.getFullYear()}`;
  }
  return `${month} ${day} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function isExecutable(stat: StatData): boolean {
  return (stat.mode & S_IFMT) === 0o100000 && (stat.mode & 0o111) !== 0;
}

function colorName(entry: Entry, color: boolean): string {
  if (!color) {
    return entry.name;
  }
  if (isLink(entry.stat)) {
    return `\x1b[1;36m${entry.name}\x1b[0m`;
  }
  if (isDir(entry.stat)) {
    return `\x1b[1;34m${entry.name}\x1b[0m`;
  }
  if (isExecutable(entry.stat)) {
    return `\x1b[1;32m${entry.name}\x1b[0m`;
  }
  return entry.name;
}

function classify(entry: Entry): string {
  if (isLink(entry.stat)) {
    return "@";
  }
  if (isDir(entry.stat)) {
    return "/";
  }
  return isExecutable(entry.stat) ? "*" : "";
}

function displayWidth(text: string): number {
  return Array.from(text).length;
}

function load(path: string, name: string): Entry {
  const fs = runtime().fs;
  const stat = fs.stat(path, false);
  let target: StatData | null = null;
  if (isLink(stat)) {
    try {
      target = fs.stat(path, true);
    } catch {
      target = null;
    }
  }
  return { name, path, stat, target };
}

/** `ls`. */
export const ls: Command = (ctx, args) => {
  const parsed = options(ctx, args, {
    flags: "laA1RhdrtSFG",
    long: {
      all: "a",
      "almost-all": "A",
      recursive: "R",
      "human-readable": "h",
      directory: "d",
      reverse: "r",
      classify: "F",
      color: "G",
      "color=": "G",
    },
  });
  if (!parsed) {
    return 2;
  }
  const flag = (letter: string): boolean => parsed.flags.has(letter);
  const tty = ctx.io.isTty(1);
  const color = tty && parsed.flags.get("G") !== "never";
  const opts = {
    long: flag("l"),
    all: flag("a"),
    almostAll: flag("A"),
    one: flag("1") || !tty,
    recursive: flag("R"),
    human: flag("h"),
    directory: flag("d"),
    reverse: flag("r"),
    byTime: flag("t"),
    bySize: flag("S"),
    classify: flag("F"),
    color,
  };
  const operands = parsed.operands.length > 0 ? parsed.operands : ["."];
  let status = 0;
  const files: Entry[] = [];
  const dirs: Entry[] = [];
  for (const operand of operands) {
    const path = resolvePath(ctx.cwd, operand);
    let entry: Entry;
    try {
      entry = load(path, operand);
    } catch (error) {
      ctx.io.err(`ls: cannot access '${operand}': ${errorText(error)}\n`);
      status = 2;
      continue;
    }
    const effective = entry.target ?? entry.stat;
    if (
      !opts.directory &&
      isDir(effective) &&
      !(opts.long && isLink(entry.stat) && !operand.endsWith("/"))
    ) {
      dirs.push(entry);
    } else {
      files.push(entry);
    }
  }
  const sortEntries = (entries: Entry[]): Entry[] => {
    const sorted = [...entries].sort((a, b) => {
      if (opts.byTime && a.stat.mtimeMs !== b.stat.mtimeMs) {
        return b.stat.mtimeMs - a.stat.mtimeMs;
      }
      if (opts.bySize && a.stat.size !== b.stat.size) {
        return b.stat.size - a.stat.size;
      }
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return opts.reverse ? sorted.reverse() : sorted;
  };
  let printed = false;
  if (files.length > 0) {
    print(ctx, sortEntries(files), opts);
    printed = true;
  }
  const queue = sortEntries(dirs);
  const showHeaders = operands.length > 1 || opts.recursive;
  while (queue.length > 0) {
    const dir = queue.shift() as Entry;
    let names: string[];
    try {
      names = runtime()
        .fs.readdir(dir.path)
        .map((entry) => entry.name);
    } catch (error) {
      ctx.io.err(`ls: cannot open directory '${dir.name}': ${errorText(error)}\n`);
      status = 2;
      continue;
    }
    if (opts.all) {
      names = [".", "..", ...names];
    } else if (!opts.almostAll) {
      names = names.filter((name) => !name.startsWith("."));
    }
    const entries: Entry[] = [];
    for (const name of names) {
      try {
        entries.push(load(resolvePath(dir.path, name), name));
      } catch {
        // Vanished while listing.
      }
    }
    if (printed) {
      ctx.io.out("\n");
    }
    if (showHeaders) {
      ctx.io.out(`${dir.name}:\n`);
    }
    const sorted = sortEntries(entries);
    if (opts.long) {
      let blocks = 0;
      for (const entry of sorted) {
        blocks += Math.ceil(entry.stat.size / 1024);
      }
      ctx.io.out(`total ${blocks}\n`);
    }
    print(ctx, sorted, opts);
    printed = true;
    if (opts.recursive) {
      const children = sorted
        .filter((entry) => entry.name !== "." && entry.name !== ".." && isDir(entry.stat))
        .map((entry) => ({ ...entry, name: `${dir.name.replace(/\/$/, "")}/${entry.name}` }));
      queue.unshift(...children);
    }
    if (ctx.io.broken) {
      break;
    }
  }
  return status;
};

function print(
  ctx: CommandContext,
  entries: Entry[],
  opts: { long: boolean; one: boolean; human: boolean; classify: boolean; color: boolean },
): void {
  if (entries.length === 0) {
    return;
  }
  const label = (entry: Entry): string =>
    colorName(entry, opts.color) + (opts.classify ? classify(entry) : "");
  const plainLabel = (entry: Entry): string => entry.name + (opts.classify ? classify(entry) : "");
  if (opts.long) {
    const sizes = entries.map((entry) =>
      opts.human ? humanSize(entry.stat.size) : String(entry.stat.size),
    );
    const links = entries.map((entry) => String(entry.stat.nlink));
    const sizeWidth = Math.max(...sizes.map((s) => s.length));
    const linkWidth = Math.max(...links.map((s) => s.length));
    let out = "";
    entries.forEach((entry, index) => {
      let line = `${modeString(entry.stat.mode)} ${links[index].padStart(linkWidth)} ${USERNAME} ${USERNAME} ${sizes[index].padStart(sizeWidth)} ${dateString(entry.stat.mtimeMs)} ${label(entry)}`;
      if (isLink(entry.stat)) {
        try {
          line += ` -> ${runtime().fs.readlink(entry.path)}`;
        } catch {
          // Unreadable link.
        }
      }
      out += `${line}\n`;
    });
    ctx.io.out(out);
    return;
  }
  if (opts.one) {
    ctx.io.out(entries.map((entry) => `${label(entry)}\n`).join(""));
    return;
  }
  const real = ctx.io.fd(1);
  let columns = 80;
  try {
    columns = real === null ? 80 : runtime().tty.windowSize(real).columns || 80;
  } catch {
    columns = 80;
  }
  const widths = entries.map((entry) => displayWidth(plainLabel(entry)));
  // Find the most columns that fit, filling down columns first.
  let best = { cols: 1, rows: entries.length, colWidths: [Math.max(...widths)] };
  for (let cols = entries.length; cols >= 1; cols--) {
    const rows = Math.ceil(entries.length / cols);
    const colWidths: number[] = [];
    for (let c = 0; c < cols; c++) {
      let width = 0;
      for (let r = 0; r < rows; r++) {
        const index = c * rows + r;
        if (index < entries.length) {
          width = Math.max(width, widths[index]);
        }
      }
      colWidths.push(width);
    }
    const total = colWidths.reduce((sum, width) => sum + width, 0) + (cols - 1) * 2;
    if (total <= columns) {
      best = { cols, rows, colWidths };
      break;
    }
  }
  let out = "";
  for (let r = 0; r < best.rows; r++) {
    let line = "";
    for (let c = 0; c < best.cols; c++) {
      const index = c * best.rows + r;
      if (index >= entries.length) {
        continue;
      }
      const isLast = c === best.cols - 1 || (c + 1) * best.rows + r >= entries.length;
      line += label(entries[index]);
      if (!isLast) {
        line += " ".repeat(best.colWidths[c] - widths[index] + 2);
      }
    }
    out += `${line}\n`;
  }
  ctx.io.out(out);
}
