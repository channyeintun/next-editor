// `rmdir [-p] dirs…`.
import { runtime } from "../../../runtime";
import type { Command } from "../context";
import { dirName, errorText, options } from "./util";

/** `rmdir`. */
export const rmdir: Command = (ctx, args) => {
  const parsed = options(ctx, args, { flags: "pv", long: { parents: "p" } });
  if (!parsed) {
    return 1;
  }
  if (parsed.operands.length === 0) {
    ctx.io.err("rmdir: missing operand\n");
    return 1;
  }
  let status = 0;
  for (const operand of parsed.operands) {
    let current = operand;
    for (;;) {
      try {
        runtime().fs.rmdir(ctx.resolve(current));
      } catch (error) {
        ctx.io.err(`rmdir: failed to remove '${current}': ${errorText(error)}\n`);
        status = 1;
        break;
      }
      if (!parsed.flags.has("p")) {
        break;
      }
      const parent = dirName(current);
      if (parent === "." || parent === "/" || parent === current) {
        break;
      }
      current = parent;
    }
  }
  return status;
};
