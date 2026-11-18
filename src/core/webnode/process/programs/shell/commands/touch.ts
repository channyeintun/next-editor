// `touch [-acm] [-d date] [-r file] files…`: creates empty files or updates their times.
import { errnoCodeOf } from "../../../../errors";
import { O_CREAT, O_WRONLY } from "../../../../kernel/vfs/types";
import type { Command } from "../context";
import { absolutePath, errorText, options } from "./util";

/** `touch`. */
export const touch: Command = (ctx, args) => {
  const parsed = options(ctx, args, {
    flags: "cam",
    values: "dtr",
    long: { "no-create": "c", "date=": "d" },
  });
  if (!parsed) {
    return 1;
  }
  if (parsed.operands.length === 0) {
    ctx.io.err("touch: missing file operand\n");
    return 1;
  }
  const fs = ctx.fs;
  // Null sets a time to now. Both set to now needs only write permission (on
  // a device root owns, /dev/null); a time given needs the file's owner.
  let atime: number | null = null;
  let mtime: number | null = null;
  const date = parsed.flags.get("d");
  if (typeof date === "string") {
    const parsedDate = Date.parse(date);
    if (Number.isNaN(parsedDate)) {
      ctx.io.err(`touch: invalid date format '${date}'\n`);
      return 1;
    }
    atime = mtime = parsedDate;
  }
  const reference = parsed.flags.get("r");
  if (typeof reference === "string") {
    try {
      const stat = fs.stat(absolutePath(ctx.cwd, reference), true);
      atime = stat.atimeMs;
      mtime = stat.mtimeMs;
    } catch (error) {
      ctx.io.err(`touch: failed to get attributes of '${reference}': ${errorText(error)}\n`);
      return 1;
    }
  }
  // -a changes only the access time, -m only the modification time, both or
  // neither both of them.
  const changeAccess = parsed.flags.has("a") || !parsed.flags.has("m");
  const changeModification = parsed.flags.has("m") || !parsed.flags.has("a");
  if (parsed.flags.has("t")) {
    ctx.io.err("touch: -t: not supported\n");
    return 1;
  }
  const noCreate = parsed.flags.has("c");
  let status = 0;
  for (const operand of parsed.operands) {
    const path = absolutePath(ctx.cwd, operand);
    // As GNU touch: open (creating) unless -c, then set the times by path.
    // Only a failed time change is an error; the open's error explains it
    // when there was one (a directory's EISDIR does not), and -c passes over
    // only a file that is not there.
    let openError: unknown = null;
    if (!noCreate) {
      try {
        fs.close(fs.open(path, O_WRONLY | O_CREAT, 0o666));
      } catch (error) {
        openError = error;
      }
    }
    try {
      // The time kept is passed as it is, which is a time given: as Linux's
      // utimensat(2) with one time left alone, that needs the owner.
      const kept = changeAccess && changeModification ? null : fs.stat(path, true);
      fs.utimes(
        path,
        kept !== null && !changeAccess ? kept.atimeMs : atime,
        kept !== null && !changeModification ? kept.mtimeMs : mtime,
        true,
      );
    } catch (error) {
      if (openError !== null && errnoCodeOf(openError) !== "EISDIR") {
        ctx.io.err(`touch: cannot touch '${operand}': ${errorText(openError)}\n`);
      } else if (noCreate && errnoCodeOf(error) === "ENOENT") {
        continue;
      } else {
        ctx.io.err(`touch: setting times of '${operand}': ${errorText(error)}\n`);
      }
      status = 1;
    }
  }
  return status;
};
