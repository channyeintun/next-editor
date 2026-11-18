// `ln [-s] [-f] target [link]` and `ln target… dir`.
import { errnoCodeOf } from "../../../../errors";
import { runtime } from "../../../runtime";
import type { Command } from "../context";
import {
  absolutePath,
  baseName,
  errorText,
  isDir,
  options,
  quoteName,
  statOrError,
  targetInDirectory,
  tryStat,
} from "./util";

/**
 * What GNU ln says it failed to do. A hard link names both ends, except
 * where the link's own name says it all (it exists, or its directory is
 * full or read-only); a symbolic link names its target only when that is
 * empty.
 */
function linkFailure(symbolic: boolean, link: string, target: string, error: unknown): string {
  if (symbolic) {
    return target === ""
      ? `failed to create symbolic link '${link}' -> '${target}'`
      : `failed to create symbolic link '${link}'`;
  }
  const code = errnoCodeOf(error);
  return code === "EEXIST" || code === "ENOSPC" || code === "EROFS"
    ? `failed to create hard link '${link}'`
    : `failed to create hard link '${link}' => '${target}'`;
}

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
    const lastStat = tryStat(absolutePath(ctx.cwd, last));
    if (lastStat && isDir(lastStat) && !parsed.flags.has("n") && !parsed.flags.has("T")) {
      pairs = operands.slice(0, -1).map((target) => [target, targetInDirectory(last, target)]);
    } else if (operands.length > 2) {
      ctx.io.err(`ln: target '${last}' is not a directory\n`);
      return 1;
    } else {
      pairs = [[operands[0], last]];
    }
  }
  let status = 0;
  for (const [target, link] of pairs) {
    const linkPath = absolutePath(ctx.cwd, link);
    const targetPath = absolutePath(ctx.cwd, target);
    // A hard link needs what it links to (GNU ln looks before it links).
    const found = symbolic ? null : statOrError(targetPath, false);
    if (found !== null && "error" in found) {
      ctx.io.err(`ln: failed to access '${target}': ${errorText(found.error)}\n`);
      status = 1;
      continue;
    }
    if (found !== null && isDir(found)) {
      ctx.io.err(`ln: ${quoteName(target)}: hard link not allowed for directory\n`);
      status = 1;
      continue;
    }
    try {
      if (force && tryStat(linkPath, false)) {
        fs.unlink(linkPath);
      }
      if (symbolic) {
        fs.symlink(target, linkPath);
      } else {
        fs.link(targetPath, linkPath);
      }
    } catch (error) {
      ctx.io.err(`ln: ${linkFailure(symbolic, link, target, error)}: ${errorText(error)}\n`);
      status = 1;
    }
  }
  return status;
};
