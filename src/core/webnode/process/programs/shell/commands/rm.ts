// `rm [-rRf] [-d] files…`.
import { runtime } from "../../../runtime";
import type { Command } from "../context";
import { errorText, isDir, options } from "./util";

/** `rm`. */
export const rm: Command = (ctx, args) => {
  const parsed = options(ctx, args, {
    flags: "rRfdvi",
    long: { recursive: "r", force: "f", dir: "d", verbose: "v" },
  });
  if (!parsed) {
    return 1;
  }
  const recursive = parsed.flags.has("r") || parsed.flags.has("R");
  const force = parsed.flags.has("f");
  if (parsed.operands.length === 0) {
    if (force) {
      return 0;
    }
    ctx.io.err("rm: missing operand\n");
    return 1;
  }
  // -i would ask before each removal; a script here cannot answer, so refuse
  // rather than remove what the user wanted to be asked about. -f overrides.
  const confirm = parsed.flags.has("i") && !force;
  const fs = runtime().fs;
  let status = 0;
  for (const operand of parsed.operands) {
    // POSIX: an operand whose last component is . or .. is skipped, even when
    // its path names another directory (`rm -rf ..` would remove the parent).
    const last = operand.replace(/\/+$/, "").split("/").pop();
    if (last === "." || last === "..") {
      ctx.io.err(`rm: refusing to remove '.' or '..' directory: skipping '${operand}'\n`);
      status = 1;
      continue;
    }
    const path = ctx.resolve(operand);
    if (path === "/") {
      ctx.io.err("rm: it is dangerous to operate recursively on '/'\n");
      status = 1;
      continue;
    }
    let stat;
    try {
      stat = fs.stat(path, false);
    } catch (error) {
      if (!force) {
        ctx.io.err(`rm: cannot remove '${operand}': ${errorText(error)}\n`);
        status = 1;
      }
      continue;
    }
    if (confirm) {
      ctx.io.err(`rm: not removing '${operand}': -i cannot ask for confirmation here\n`);
      status = 1;
      continue;
    }
    try {
      if (isDir(stat)) {
        if (recursive) {
          fs.rm(path, true, true);
        } else if (parsed.flags.has("d")) {
          fs.rmdir(path);
        } else {
          ctx.io.err(`rm: cannot remove '${operand}': Is a directory\n`);
          status = 1;
          continue;
        }
      } else {
        fs.unlink(path);
      }
      if (parsed.flags.has("v")) {
        ctx.io.out(`removed '${operand}'\n`);
      }
    } catch (error) {
      ctx.io.err(`rm: cannot remove '${operand}': ${errorText(error)}\n`);
      status = 1;
    }
  }
  return status;
};
