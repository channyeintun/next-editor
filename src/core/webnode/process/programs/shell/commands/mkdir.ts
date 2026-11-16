// `mkdir [-p] [-m mode] dirs…`.
import { runtime } from "../../../runtime";
import type { Command } from "../context";
import { errorCode, errorText, options } from "./util";

/** `mkdir`. */
export const mkdir: Command = (ctx, args) => {
  const parsed = options(ctx, args, {
    flags: "pv",
    values: "m",
    long: { parents: "p", verbose: "v", "mode=": "m" },
  });
  if (!parsed) {
    return 1;
  }
  if (parsed.operands.length === 0) {
    ctx.io.err("mkdir: missing operand\n");
    return 1;
  }
  const parents = parsed.flags.has("p");
  const modeText = parsed.flags.get("m");
  const mode =
    typeof modeText === "string" && /^[0-7]+$/.test(modeText) ? parseInt(modeText, 8) : 0o777;
  let status = 0;
  for (const operand of parsed.operands) {
    const path = ctx.resolve(operand);
    try {
      runtime().fs.mkdir(path, parents, mode);
      if (parsed.flags.has("v")) {
        ctx.io.out(`mkdir: created directory '${operand}'\n`);
      }
    } catch (error) {
      if (parents && errorCode(error) === "EEXIST") {
        continue;
      }
      ctx.io.err(`mkdir: cannot create directory '${operand}': ${errorText(error)}\n`);
      status = 1;
    }
  }
  return status;
};
