// `cp [-rRfnpavT] source… dest`: files, and directory trees with -r.
import { createSystemError, errnoCodeOf } from "../../../../errors";
import { O_CREAT, O_EXCL, O_TRUNC, O_WRONLY, type StatData } from "../../../../kernel/vfs/types";
import type { Command, CommandContext } from "../context";
import { ReadInterrupted, descriptorOf } from "../io";
import {
  absolutePath,
  baseName,
  dirName,
  errorText,
  inputChunks,
  isDir,
  isFile,
  isLink,
  options,
  sameFile,
  statOrError,
  targetInDirectory,
  tryStat,
} from "./util";

/** -p / -a: gives the copy its source's times (a directory's after its entries are written). */
function keepTimes(copying: Copying, stat: StatData, to: string): void {
  copying.ctx.fs.utimes(to, stat.atimeMs, stat.mtimeMs, false);
}

/** One operand's copy: its options, and what its messages name. */
interface Copying {
  ctx: CommandContext;
  noClobber: boolean;
  preserve: boolean;
  /** -f: a destination that cannot be opened is removed and made anew. */
  force: boolean;
  verbose: boolean;
  /** The operand and its target as the user spelled them. */
  top: [string, string];
  /**
   * The first directory this copy made, and the name it made it under. A
   * source directory that is this one is the copy itself, reached because the
   * target lies inside the source.
   */
  made: { stat: StatData; label: string } | null;
  /** Set once the copy met itself: nothing more of this operand is copied. */
  intoSelf: boolean;
}

/** A path and the name the messages give it, with `name` added to both. */
function child(path: string, label: string, name: string): [string, string] {
  return [`${path}/${name}`, `${label.replace(/\/+$/, "")}/${name}`];
}

/**
 * What a file's copy finds at its destination, as GNU cp looks before it
 * copies: "absent" or "present" (written in place) to go on with, "done"
 * for one -n leaves, "failed" for a refusal it has reported. `fresh` says
 * the destination's directory was made by this copy, so nothing can be
 * there. With -v, a copy that goes on is announced.
 */
function checkTarget(
  copying: Copying,
  stat: StatData,
  to: string,
  labels: [string, string],
  fresh: boolean,
): "absent" | "present" | "done" | "failed" {
  const io = copying.ctx.io;
  let found: "absent" | "present" = "absent";
  if (!fresh) {
    const there = statOrError(to);
    if (!("error" in there)) {
      if (sameFile(there, stat)) {
        io.err(`cp: '${labels[0]}' and '${labels[1]}' are the same file\n`);
        return "failed";
      }
      if (copying.noClobber) {
        return "done";
      }
      if (isDir(there)) {
        io.err(`cp: cannot overwrite directory '${labels[1]}' with non-directory '${labels[0]}'\n`);
        return "failed";
      }
      found = "present";
    } else if (errnoCodeOf(there.error) !== "ENOENT") {
      io.err(`cp: cannot stat '${labels[1]}': ${errorText(there.error)}\n`);
      return "failed";
    } else if (tryStat(to, false)) {
      io.err(`cp: not writing through dangling symlink '${labels[1]}'\n`);
      return "failed";
    }
  }
  if (copying.verbose) {
    io.out(`'${labels[0]}' -> '${labels[1]}'\n`);
  }
  return found;
}

/**
 * Opens a copy's destination with `open` (flags, mode), as GNU cp does: one
 * that is there in place, truncated, keeping its mode; a new one created
 * with the source's permission bits, which the filesystem cuts by the umask
 * as for any created file; with -f, one that cannot be opened is removed and
 * made anew. Returns what `open` returned, or null for a refusal it has
 * reported.
 */
function openTarget<T>(
  copying: Copying,
  stat: StatData,
  to: string,
  labels: [string, string],
  present: boolean,
  open: (flags: number, mode: number) => T,
): T | null {
  const fs = copying.ctx.fs;
  const io = copying.ctx.io;
  const create = (): { opened: T } | { refusal: unknown } => {
    try {
      return { opened: open(O_WRONLY | O_CREAT | O_EXCL, stat.mode & 0o777) };
    } catch (error) {
      return { refusal: error };
    }
  };
  let result: { opened: T } | { refusal: unknown };
  if (present) {
    try {
      result = { opened: open(O_WRONLY | O_TRUNC, 0) };
    } catch (error) {
      if (!copying.force) {
        result = { refusal: error };
      } else {
        // GNU cp -f: a destination it could not open is removed, then made anew.
        try {
          fs.unlink(to);
        } catch (unlinkError) {
          io.err(`cp: cannot remove '${labels[1]}': ${errorText(unlinkError)}\n`);
          return null;
        }
        result = create();
      }
    }
  } else {
    result = create();
  }
  if ("refusal" in result) {
    // A trailing slash asks for a directory, and there is none.
    const reason =
      errnoCodeOf(result.refusal) === "EISDIR" && labels[1].endsWith("/")
        ? "Not a directory"
        : errorText(result.refusal);
    io.err(`cp: cannot create regular file '${labels[1]}': ${reason}\n`);
    return null;
  }
  return result.opened;
}

/** -p / -a on a file copied: its source's mode and times. */
function keepAttributes(copying: Copying, stat: StatData, to: string): void {
  if (copying.preserve) {
    copying.ctx.fs.chmod(to, stat.mode & 0o7777, true);
    keepTimes(copying, stat, to);
  }
}

/**
 * Copies one file as GNU cp does, each refusal reported with the side that
 * refused (`checkTarget`, `openTarget`): read whole, written in one go.
 * Returns whether it copied.
 */
function copyFile(
  copying: Copying,
  stat: StatData,
  from: string,
  to: string,
  labels: [string, string],
  fresh: boolean,
): boolean {
  const fs = copying.ctx.fs;
  const target = checkTarget(copying, stat, to, labels, fresh);
  if (target === "done" || target === "failed") {
    return target === "done";
  }
  let data: Uint8Array;
  try {
    data = fs.readFile(from);
  } catch (error) {
    copying.ctx.io.err(`cp: cannot open '${labels[0]}' for reading: ${errorText(error)}\n`);
    return false;
  }
  const written = openTarget(copying, stat, to, labels, target === "present", (flags, mode) => {
    fs.writeFile(to, data, flags, mode);
    return true;
  });
  if (written === null) {
    return false;
  }
  keepAttributes(copying, stat, to);
  return true;
}

/**
 * Copies a source that is no regular file (a terminal, a pipe, a device,
 * the command's own `/dev/stdin`) as GNU cp's read loop does: each chunk is
 * written as it arrives (`inputChunks`), so a copy of a terminal holds what
 * was typed so far and a signal ends it as it ends cat. Returns whether it
 * copied.
 */
async function copyStream(
  copying: Copying,
  stat: StatData,
  source: string,
  to: string,
  labels: [string, string],
): Promise<boolean> {
  const fs = copying.ctx.fs;
  const io = copying.ctx.io;
  const target = checkTarget(copying, stat, to, labels, false);
  if (target === "done" || target === "failed") {
    return target === "done";
  }
  const fd = openTarget(copying, stat, to, labels, target === "present", (flags, mode) =>
    fs.open(to, flags, mode),
  );
  if (fd === null) {
    return false;
  }
  let read = false;
  try {
    for await (const chunk of inputChunks(copying.ctx, source)) {
      if (!(chunk instanceof Uint8Array)) {
        io.err(
          read
            ? `cp: error reading '${labels[0]}': ${chunk.error}\n`
            : `cp: cannot open '${labels[0]}' for reading: ${chunk.error}\n`,
        );
        return false;
      }
      read = true;
      try {
        for (let done = 0; done < chunk.length;) {
          done += fs.write(fd, chunk.subarray(done), null);
        }
      } catch (error) {
        io.err(`cp: error writing '${labels[1]}': ${errorText(error)}\n`);
        return false;
      }
    }
  } finally {
    fs.close(fd);
  }
  keepAttributes(copying, stat, to);
  return true;
}

/** Copies a symbolic link as a link. Returns whether it copied. */
function copyLink(
  copying: Copying,
  stat: StatData,
  from: string,
  to: string,
  labels: [string, string],
  fresh: boolean,
): boolean {
  const fs = copying.ctx.fs;
  const io = copying.ctx.io;
  if (!fresh && tryStat(to, false)) {
    if (copying.noClobber) {
      return true;
    }
    try {
      fs.unlink(to);
    } catch (error) {
      io.err(`cp: cannot remove '${labels[1]}': ${errorText(error)}\n`);
      return false;
    }
  }
  if (copying.verbose) {
    io.out(`'${labels[0]}' -> '${labels[1]}'\n`);
  }
  let target: string;
  try {
    target = fs.readlink(from);
  } catch (error) {
    io.err(`cp: cannot read symbolic link '${labels[0]}': ${errorText(error)}\n`);
    return false;
  }
  try {
    fs.symlink(target, to);
  } catch (error) {
    io.err(`cp: cannot create symbolic link '${labels[1]}' to '${target}': ${errorText(error)}\n`);
    return false;
  }
  if (copying.preserve) {
    keepTimes(copying, stat, to);
  }
  return true;
}

/**
 * Reports a source directory that is the copy's own first directory, in
 * GNU's words: `into itself` when it was reached under the name it was made
 * with, and as a hard link to a directory when under another.
 */
function reportIntoSelf(
  copying: Copying,
  made: { label: string },
  from: string,
  labels: [string, string],
): void {
  const cwd = copying.ctx.cwd;
  const here = tryStat(dirName(from), false);
  const there = tryStat(absolutePath(cwd, dirName(made.label)), false);
  const sameName =
    baseName(labels[0]) === baseName(made.label) &&
    here !== null &&
    there !== null &&
    sameFile(here, there);
  copying.ctx.io.err(
    sameName
      ? `cp: cannot copy a directory, '${copying.top[0]}', into itself, '${copying.top[1]}'\n`
      : `cp: will not create hard link '${labels[1]}' to directory '${made.label}'\n`,
  );
  copying.intoSelf = true;
}

/**
 * Copies the tree at `from` to `to`, going on past what is refused, each
 * refusal reported, as GNU cp -r does. `fresh` is as for `copyFile`. `known`
 * is what the operand itself is (with -L, what its link points to); an entry
 * below it is looked at here, a link as a link. Returns whether all of it
 * was copied.
 */
function copyTree(
  copying: Copying,
  from: string,
  to: string,
  labels: [string, string],
  fresh: boolean,
  known: StatData | null = null,
): boolean {
  const fs = copying.ctx.fs;
  const io = copying.ctx.io;
  const found = known ?? statOrError(from, false);
  if ("error" in found) {
    io.err(`cp: cannot stat '${labels[0]}': ${errorText(found.error)}\n`);
    return false;
  }
  const stat = found;
  if (isLink(stat)) {
    return copyLink(copying, stat, from, to, labels, fresh);
  }
  if (!isDir(stat)) {
    return copyFile(copying, stat, from, to, labels, fresh);
  }
  if (copying.made !== null && sameFile(stat, copying.made.stat)) {
    reportIntoSelf(copying, copying.made, from, labels);
    return false;
  }
  let make = true;
  if (!fresh) {
    const existing = statOrError(to);
    if (!("error" in existing)) {
      if (!isDir(existing)) {
        io.err(`cp: cannot overwrite non-directory '${labels[1]}' with directory '${labels[0]}'\n`);
        return false;
      }
      make = false;
    } else if (errnoCodeOf(existing.error) !== "ENOENT") {
      io.err(`cp: cannot stat '${labels[1]}': ${errorText(existing.error)}\n`);
      return false;
    }
  }
  const mode = stat.mode & 0o7777;
  /** The mode a directory made here gets back after its entries, when it was opened up for them. */
  let closed: number | null = null;
  if (make) {
    // As GNU cp: made with the source's mode, which the filesystem cuts by
    // the mask. One its owner may then not write and search (the source's
    // own mode, or the mask's doing) is opened up while its entries are
    // written.
    let made: StatData;
    try {
      fs.mkdir(to, false, mode);
      made = fs.stat(to, false);
      if ((made.mode & 0o700) !== 0o700) {
        closed = made.mode & 0o7777;
        fs.chmod(to, closed | 0o700, true);
      }
    } catch (error) {
      io.err(`cp: cannot create directory '${labels[1]}': ${errorText(error)}\n`);
      return false;
    }
    if (copying.made === null) {
      copying.made = { stat: made, label: labels[1] };
    }
    if (copying.verbose) {
      io.out(`'${labels[0]}' -> '${labels[1]}'\n`);
    }
  }
  let all = true;
  let entries: { name: string }[] = [];
  try {
    entries = fs.readdir(from);
  } catch (error) {
    io.err(`cp: cannot access '${labels[0]}': ${errorText(error)}\n`);
    all = false;
  }
  for (const entry of entries) {
    const [childFrom, childLabel] = child(from, labels[0], entry.name);
    const [childTo, childToLabel] = child(to, labels[1], entry.name);
    all = copyTree(copying, childFrom, childTo, [childLabel, childToLabel], make) && all;
    if (copying.intoSelf) {
      break;
    }
  }
  if (copying.preserve) {
    // -p: the source's own mode, on a directory that was there as well.
    fs.chmod(to, mode, true);
    keepTimes(copying, stat, to);
  } else if (closed !== null) {
    fs.chmod(to, closed, true);
  }
  return all;
}

/**
 * What a source operand is, as cp's `stat` of it says: for the command's own
 * `/dev/stdin` and `/dev/fd/N`, which the shell holds and the kernel's path
 * would not name, the fd's own status. `descriptor` says it is one of those.
 */
function statSource(
  ctx: CommandContext,
  from: string,
  follow: boolean,
): { stat: StatData; descriptor: boolean } | { error: unknown } {
  const named = follow ? descriptorOf(from) : null;
  if (named === null) {
    const found = statOrError(from, follow);
    return "error" in found ? found : { stat: found, descriptor: false };
  }
  const real = ctx.io.fd(named);
  try {
    if (real === null) {
      // As Linux's /dev/fd, which has no entry for an fd that is not open.
      throw createSystemError("ENOENT", "stat", from);
    }
    return { stat: ctx.fs.fstat(real), descriptor: true };
  } catch (error) {
    return { error };
  }
}

/** `cp`. */
export const cp: Command = async (ctx, args) => {
  const parsed = options(ctx, args, {
    flags: "rRfnpavPLdT",
    long: {
      recursive: "r",
      force: "f",
      "no-clobber": "n",
      preserve: "p",
      archive: "a",
      verbose: "v",
    },
  });
  if (!parsed) {
    return 1;
  }
  const recursive = parsed.flags.has("r") || parsed.flags.has("R") || parsed.flags.has("a");
  // As GNU cp: an operand that is a symbolic link is copied as a link with
  // -r, -P or -d, and through it otherwise (and always with -L).
  const follow =
    parsed.flags.has("L") || !(recursive || parsed.flags.has("P") || parsed.flags.has("d"));
  const { operands } = parsed;
  if (operands.length < 2) {
    ctx.io.err(
      operands.length === 0
        ? "cp: missing file operand\n"
        : `cp: missing destination file operand after '${operands[0]}'\n`,
    );
    return 1;
  }
  const dest = operands[operands.length - 1];
  const destPath = absolutePath(ctx.cwd, dest);
  const destFound = statOrError(destPath);
  const sources = operands.slice(0, -1);
  const intoDir = !("error" in destFound) && isDir(destFound) && !parsed.flags.has("T");
  if (sources.length > 1 && !intoDir) {
    // Why the last operand is no directory to copy into.
    const reason = "error" in destFound ? errorText(destFound.error) : "Not a directory";
    ctx.io.err(`cp: target '${dest}': ${reason}\n`);
    return 1;
  }
  let status = 0;
  for (const source of sources) {
    const from = absolutePath(ctx.cwd, source);
    const to = intoDir ? `${destPath}/${baseName(source)}` : destPath;
    // What the messages name: the computed target, as GNU cp does.
    const shownTo = intoDir ? targetInDirectory(dest, source) : dest;
    const found = statSource(ctx, from, follow);
    if ("error" in found) {
      ctx.io.err(`cp: cannot stat '${source}': ${errorText(found.error)}\n`);
      status = 1;
      continue;
    }
    const { stat } = found;
    if (isDir(stat) && !recursive) {
      ctx.io.err(`cp: -r not specified; omitting directory '${source}'\n`);
      status = 1;
      continue;
    }
    const copying: Copying = {
      ctx,
      noClobber: parsed.flags.has("n"),
      preserve: parsed.flags.has("p") || parsed.flags.has("a"),
      force: parsed.flags.has("f"),
      verbose: parsed.flags.has("v"),
      top: [source, shownTo],
      made: null,
      intoSelf: false,
    };
    // A source that is no regular file is read as it delivers its bytes.
    const streamed = found.descriptor || !(isFile(stat) || isDir(stat) || isLink(stat));
    try {
      const copied = streamed
        ? await copyStream(copying, stat, from, to, copying.top)
        : isLink(stat)
          ? copyLink(copying, stat, from, to, copying.top, false)
          : isDir(stat)
            ? copyTree(copying, from, to, copying.top, false, stat)
            : copyFile(copying, stat, from, to, copying.top, false);
      if (!copied) {
        status = 1;
      }
    } catch (error) {
      if (error instanceof ReadInterrupted) {
        // A signal ended the read: the command ends of it, as a process would.
        throw error;
      }
      ctx.io.err(`cp: cannot copy '${source}': ${errorText(error)}\n`);
      status = 1;
    }
  }
  return status;
};
