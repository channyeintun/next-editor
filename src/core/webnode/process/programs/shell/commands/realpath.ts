// `realpath [-m] [-s] [--relative-to=dir] paths…`.
import { runtime } from "../../../runtime";
import type { Command } from "../context";
import { absolutePath, errorText, options, quoteName, resolvePath } from "./util";

function relative(from: string, to: string): string {
  const a = from.split("/").filter(Boolean);
  const b = to.split("/").filter(Boolean);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) {
    common++;
  }
  const parts = [...a.slice(common).map(() => ".."), ...b.slice(common)];
  return parts.length === 0 ? "." : parts.join("/");
}

/** `realpath`. */
export const realpath: Command = (ctx, args) => {
  const parsed = options(ctx, args, {
    flags: "mseqLP",
    long: { "relative-to=": "relative-to", "canonicalize-missing": "m", "no-symlinks": "s" },
  });
  if (!parsed) {
    return 1;
  }
  if (parsed.operands.length === 0) {
    ctx.io.err("realpath: missing operand\n");
    return 1;
  }
  const fs = runtime().fs;
  const resolveOne = (path: string): string => {
    const absolute = absolutePath(ctx.cwd, path);
    // -s resolves by the text alone, and -m falls back to that for what is
    // not there; an empty name is no file either way.
    if (path !== "" && parsed.flags.has("s")) {
      return resolvePath(ctx.cwd, path);
    }
    if (path !== "" && parsed.flags.has("m")) {
      try {
        return fs.realpath(absolute);
      } catch {
        return resolvePath(ctx.cwd, path);
      }
    }
    return fs.realpath(absolute);
  };
  const base = parsed.flags.get("relative-to");
  let status = 0;
  for (const operand of parsed.operands) {
    try {
      const resolved = resolveOne(operand);
      ctx.io.out(`${typeof base === "string" ? relative(resolveOne(base), resolved) : resolved}\n`);
    } catch (error) {
      if (!parsed.flags.has("q")) {
        ctx.io.err(`realpath: ${quoteName(operand)}: ${errorText(error)}\n`);
      }
      status = 1;
    }
  }
  return status;
};
