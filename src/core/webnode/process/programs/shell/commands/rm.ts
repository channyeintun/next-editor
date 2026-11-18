// `rm [-rRf] [-d] files…`.
import { errnoCodeOf } from "../../../../errors";
import type { FsBackend } from "../../../runtime";
import { runtime } from "../../../runtime";
import type { Command, CommandContext } from "../context";
import { absolutePath, errorText, isDir, options, sameFile, tryStat } from "./util";

/** What `rm -f` ignores (coreutils' `ignorable_missing`). */
function missing(error: unknown): boolean {
  const code = errnoCodeOf(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Removes the tree at `path` as GNU rm does when the filesystem refuses part
 * of it: every entry that can go goes, each refusal is reported with the
 * entry's own name, and a directory left non-empty by a refusal below it is
 * passed over silently. Returns whether all of it went.
 */
function removeTree(
  ctx: CommandContext,
  fs: FsBackend,
  path: string,
  label: string,
  force: boolean,
): boolean {
  let directory = false;
  try {
    directory = isDir(fs.stat(path, false));
  } catch (error) {
    if (force && missing(error)) {
      return true;
    }
    ctx.io.err(`rm: cannot remove '${label}': ${errorText(error)}\n`);
    return false;
  }
  if (!directory) {
    try {
      fs.unlink(path);
      return true;
    } catch (error) {
      if (force && missing(error)) {
        return true;
      }
      ctx.io.err(`rm: cannot remove '${label}': ${errorText(error)}\n`);
      return false;
    }
  }
  let unreadable: unknown = null;
  let names: string[] = [];
  try {
    names = fs.readdir(path).map((entry) => entry.name);
  } catch (error) {
    // Unreadable: an empty one can still be removed.
    unreadable = error;
  }
  let all = true;
  for (const name of names) {
    all =
      removeTree(ctx, fs, `${path}/${name}`, `${label.replace(/\/+$/, "")}/${name}`, force) && all;
  }
  if (!all) {
    return false;
  }
  try {
    fs.rmdir(path);
    return true;
  } catch (error) {
    if (force && missing(error)) {
      return true;
    }
    // Not empty because it could not be read: the reason is the read's.
    const reason = unreadable !== null && errnoCodeOf(error) === "ENOTEMPTY" ? unreadable : error;
    ctx.io.err(`rm: cannot remove '${label}': ${errorText(reason)}\n`);
    return false;
  }
}

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
  const root = tryStat("/");
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
    const path = absolutePath(ctx.cwd, operand);
    let stat;
    try {
      stat = fs.stat(path, false);
    } catch (error) {
      // -f ignores only what is not there; a refusal is still reported.
      if (!force || !missing(error)) {
        ctx.io.err(`rm: cannot remove '${operand}': ${errorText(error)}\n`);
        status = 1;
      }
      continue;
    }
    // The root is known by what it is, however the operand spells it.
    if (recursive && root !== null && sameFile(stat, root)) {
      ctx.io.err(
        `rm: it is dangerous to operate recursively on '${operand}'${operand === "/" ? "" : " (same as '/')"}\n` +
          "rm: use --no-preserve-root to override this failsafe\n",
      );
      status = 1;
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
          try {
            // The whole tree in one call. A refusal (EACCES) leaves it partly
            // removed: the entries before the refused one are gone (in name
            // order), or all of its contents when only the directory that
            // holds the tree refuses. The walk below then removes what else
            // may go and names each refusal. The filesystem refuses `link/`
            // (a link to a directory, named with a slash) as a whole with
            // ENOTDIR; GNU rm walks into it, empties the directory behind
            // the link and then fails at its rmdir, which the walk does too.
            fs.rm(path, true, true);
          } catch (error) {
            const code = errnoCodeOf(error);
            if (code !== "EACCES" && code !== "ENOTDIR") {
              throw error;
            }
            if (!removeTree(ctx, fs, path, operand, force)) {
              status = 1;
              continue;
            }
          }
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
