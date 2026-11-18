// `touch [-c] [-d date] files…`: creates empty files or updates their times.
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
  // Null sets the times to now, which needs only write permission (on a
  // device root owns, /dev/null); a time given needs the file's owner.
  let time: number | null = null;
  const date = parsed.flags.get("d");
  if (typeof date === "string") {
    const parsedDate = Date.parse(date);
    if (Number.isNaN(parsedDate)) {
      ctx.io.err(`touch: invalid date format '${date}'\n`);
      return 1;
    }
    time = parsedDate;
  }
  const reference = parsed.flags.get("r");
  if (typeof reference === "string") {
    try {
      time = fs.stat(absolutePath(ctx.cwd, reference), true).mtimeMs;
    } catch (error) {
      ctx.io.err(`touch: failed to get attributes of '${reference}': ${errorText(error)}\n`);
      return 1;
    }
  }
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
      fs.utimes(path, time, time, true);
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
