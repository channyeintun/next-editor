// `readlink [-f|-e|-m] [-n] paths…`.
import { runtime } from "../../../runtime";
import type { Command } from "../context";
import { options } from "./util";

/** `readlink`. */
export const readlink: Command = (ctx, args) => {
  const parsed = options(ctx, args, {
    flags: "femnqsvz",
    long: {
      canonicalize: "f",
      "canonicalize-existing": "e",
      "canonicalize-missing": "m",
      "no-newline": "n",
    },
  });
  if (!parsed) {
    return 1;
  }
  if (parsed.operands.length === 0) {
    ctx.io.err("readlink: missing operand\n");
    return 1;
  }
  const fs = runtime().fs;
  const canonical = parsed.flags.has("f") || parsed.flags.has("e") || parsed.flags.has("m");
  const end = parsed.flags.has("n") ? "" : "\n";
  let status = 0;
  for (const operand of parsed.operands) {
    const path = ctx.resolve(operand);
    try {
      ctx.io.out(`${canonical ? fs.realpath(path) : fs.readlink(path)}${end}`);
    } catch {
      if (parsed.flags.has("m")) {
        ctx.io.out(`${path}${end}`);
      } else {
        status = 1;
      }
    }
  }
  return status;
};
