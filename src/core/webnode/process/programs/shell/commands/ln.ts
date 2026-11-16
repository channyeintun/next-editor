// `ln [-s] [-f] target [link]` and `ln target… dir`.
import { runtime } from "../../../runtime";
import type { Command } from "../context";
import { baseName, errorText, isDir, options, tryStat } from "./util";

/** `ln`. */
export const ln: Command = (ctx, args) => {
  const parsed = options(ctx, args, { flags: "sfnvT", long: { symbolic: "s", force: "f" } });
  if (!parsed) {
    return 1;
  }
  const { operands } = parsed;
  if (operands.length === 0) {
    ctx.io.err("ln: missing file operand\n");
    return 1;
  }
  const fs = runtime().fs;
  const symbolic = parsed.flags.has("s");
  const force = parsed.flags.has("f");
  let pairs: [string, string][];
  if (operands.length === 1) {
    pairs = [[operands[0], baseName(operands[0])]];
  } else {
    const last = operands[operands.length - 1];
    const lastStat = tryStat(ctx.resolve(last));
    if (lastStat && isDir(lastStat) && !parsed.flags.has("n") && !parsed.flags.has("T")) {
      pairs = operands.slice(0, -1).map((target) => [target, `${last}/${baseName(target)}`]);
    } else if (operands.length > 2) {
      ctx.io.err(`ln: target '${last}' is not a directory\n`);
      return 1;
    } else {
      pairs = [[operands[0], last]];
    }
  }
  let status = 0;
  for (const [target, link] of pairs) {
    const linkPath = ctx.resolve(link);
    try {
      if (force && tryStat(linkPath, false)) {
        fs.unlink(linkPath);
      }
      if (symbolic) {
        fs.symlink(target, linkPath);
      } else {
        fs.link(ctx.resolve(target), linkPath);
      }
    } catch (error) {
      ctx.io.err(
        `ln: failed to create ${symbolic ? "symbolic " : "hard "}link '${link}': ${errorText(error)}\n`,
      );
      status = 1;
    }
  }
  return status;
};
