// `touch [-c] [-d date] files…`: creates empty files or updates their times.
import { O_CREAT, O_WRONLY } from "../../../../kernel/vfs/types";
import { runtime } from "../../../runtime";
import type { Command } from "../context";
import { errorText, options } from "./util";

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
  const fs = runtime().fs;
  let time = Date.now();
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
      time = fs.stat(ctx.resolve(reference), true).mtimeMs;
    } catch (error) {
      ctx.io.err(`touch: failed to get attributes of '${reference}': ${errorText(error)}\n`);
      return 1;
    }
  }
  if (parsed.flags.has("t")) {
    ctx.io.err("touch: -t: not supported\n");
    return 1;
  }
  let status = 0;
  for (const operand of parsed.operands) {
    const path = ctx.resolve(operand);
    try {
      if (!fs.exists(path)) {
        if (parsed.flags.has("c")) {
          continue;
        }
        fs.close(fs.open(path, O_WRONLY | O_CREAT, 0o666));
      }
      fs.utimes(path, time, time, true);
    } catch (error) {
      ctx.io.err(`touch: cannot touch '${operand}': ${errorText(error)}\n`);
      status = 1;
    }
  }
  return status;
};
