// `ls` with -l -a -A -1 -R -h -d -r -t -S -F; columns and colours only when
// standard output is a terminal.
import { errnoCodeOf } from "../../../../errors";
import type { DirEntryType, StatData } from "../../../../kernel/vfs/types";
import { ROOT_ID, S_IFDIR, S_IFLNK, S_IFMT, S_IFREG } from "../../../../kernel/vfs/types";
import { USERNAME } from "../../../platform";
import { runtime } from "../../../runtime";
import type { Command, CommandContext } from "../context";
import { absolutePath, errorText, isDir, isLink, options } from "./util";

/**
 * The name `ls -l` prints for a user or a group: root's for what the kernel
 * gave to root (`/dev` and its devices), the one user's for everything else.
 * Both names are four letters long, so the columns need no padding.
 */
function ownerName(id: number): string {
  return id === ROOT_ID ? "root" : USERNAME;
}

interface Entry {
  name: string;
  path: string;
  stat: StatData;
  /** The target's stat for a symlink (null when dangling). */
  target: StatData | null;
  /**
   * Set when the entry could be listed but not looked at (its directory
   * cannot be searched): `stat` then holds only the kind the listing gave,
   * as GNU ls has from `d_type`, and `-l` prints `?` for the rest.
   */
  denied?: true;
}

/** The stat record of an entry known only by the kind its directory listed. */
function listedOnly(type: DirEntryType): StatData {
  const kind = type === "dir" ? S_IFDIR : type === "symlink" ? S_IFLNK : S_IFREG;
  return {
    dev: 0,
    ino: 0,
    mode: kind,
    nlink: 0,
    uid: 0,
    gid: 0,
    rdev: 0,
    size: 0,
    blksize: 0,
    blocks: 0,
    atimeMs: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    birthtimeMs: 0,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The special bit shown over each class's `x` (setuid, setgid, sticky), and
 * its letter: lower case over `x`, upper case where `x` is not set.
 */
const SPECIAL_BITS: [bit: number, letter: string][] = [
  [0o4000, "s"],
  [0o2000, "s"],
  [0o1000, "t"],
];

/** `drwxr-xr-x` for a mode, with GNU's s/S over x for setuid and setgid, and t/T for sticky. */
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
  for (let shift = 6, index = 0; shift >= 0; shift -= 3, index++) {
    const bits = mode >> shift;
    const [special, mark] = SPECIAL_BITS[index];
    const x = bits & 1 ? "x" : "-";
    out += (bits & 4 ? "r" : "-") + (bits & 2 ? "w" : "-");
    out += mode & special ? (x === "x" ? mark : mark.toUpperCase()) : x;
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

/** The length of the longest of `texts` (a directory may hold more entries than a call takes arguments). */
function longest(texts: string[]): number {
  return texts.reduce((most, text) => Math.max(most, text.length), 0);
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
    const path = absolutePath(ctx.cwd, operand);
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
  if (files.length > 0) {
    print(ctx, sortEntries(files), opts);
    // As GNU ls: a blank line ends the files when directories follow,
    // whether or not it can open them.
    if (dirs.length > 0) {
      ctx.io.out("\n");
    }
  }
  // A blank line goes between two directories it listed.
  let listedOne = false;
  let queue = sortEntries(dirs);
  const showHeaders = operands.length > 1 || opts.recursive;
  while (queue.length > 0) {
    const dir = queue.shift() as Entry;
    let listed: { name: string; type: DirEntryType | null }[];
    try {
      listed = runtime().fs.readdir(dir.path);
    } catch (error) {
      ctx.io.err(`ls: cannot open directory '${dir.name}': ${errorText(error)}\n`);
      status = 2;
      continue;
    }
    if (opts.all) {
      listed = [{ name: ".", type: null }, { name: "..", type: null }, ...listed];
    } else if (!opts.almostAll) {
      listed = listed.filter((entry) => !entry.name.startsWith("."));
    }
    const entries: Entry[] = [];
    // Looking at an entry needs it only for -l, -F and colours, as in GNU ls.
    const looks = opts.long || opts.classify || opts.color;
    for (const { name, type } of listed) {
      // `.` and `..` are looked up in the directory like any other name.
      const path = `${dir.path}/${name}`;
      try {
        entries.push(load(path, name));
      } catch (error) {
        if (errnoCodeOf(error) !== "EACCES") {
          continue; // Vanished while listing.
        }
        if (looks && !(opts.classify && !opts.long && !opts.color && type !== "file")) {
          ctx.io.err(
            `ls: cannot access '${dir.name.replace(/\/+$/, "")}/${name}': ${errorText(error)}\n`,
          );
          status = Math.max(status, 1);
        }
        entries.push({
          name,
          path,
          stat: listedOnly(type ?? "dir"),
          target: null,
          denied: true,
        });
      }
    }
    if (listedOne) {
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
    listedOne = true;
    if (opts.recursive) {
      const children = sorted
        .filter((entry) => entry.name !== "." && entry.name !== ".." && isDir(entry.stat))
        .map((entry) => ({ ...entry, name: `${dir.name.replace(/\/$/, "")}/${entry.name}` }));
      queue = children.concat(queue);
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
    const sizeWidth = longest(sizes);
    const linkWidth = longest(links);
    let out = "";
    entries.forEach((entry, index) => {
      if (entry.denied) {
        out += `${modeString(entry.stat.mode).slice(0, 1)}????????? ${"?".padStart(linkWidth)} ? ? ${"?".padStart(sizeWidth)} ${"?".padStart(12)} ${entry.name}\n`;
        return;
      }
      let line = `${modeString(entry.stat.mode)} ${links[index].padStart(linkWidth)} ${ownerName(entry.stat.uid)} ${ownerName(entry.stat.gid)} ${sizes[index].padStart(sizeWidth)} ${dateString(entry.stat.mtimeMs)} ${label(entry)}`;
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
  let best = {
    cols: 1,
    rows: entries.length,
    colWidths: [widths.reduce((most, width) => Math.max(most, width), 0)],
  };
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
