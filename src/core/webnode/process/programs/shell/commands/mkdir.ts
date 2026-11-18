// `mkdir [-p] [-m mode] dirs…`.
import { errnoCodeOf } from "../../../../errors";
import type { Command, CommandContext } from "../context";
import { X_OK } from "../../../../kernel/vfs/types";
import { absolutePath, errnoText, errorText, isDir, options, statOrError, tryStat } from "./util";

/**
 * The directories `operand` goes through, each as the operand spells it up to
 * there (`a/b/c`: `a`, `a/b`), without the operand itself.
 */
function ancestors(operand: string): string[] {
  const parts = operand.split("/");
  const last = parts.findLastIndex((part) => part !== "");
  const names: string[] = [];
  for (let i = 0; i < last; i++) {
    if (parts[i] !== "") {
      names.push(parts.slice(0, i + 1).join("/"));
    }
  }
  return names;
}

/**
 * What `mkdir -p operand` names when it fails with `error`, and why, as GNU
 * mkdir does. It makes and enters the operand's directories one after the
 * other, so it names the operand up to the first one it could neither make
 * nor enter: one that is not there (the reason is the failed mkdir's), a
 * directory it may not search, or something that is no directory. When all
 * of those are there, the failure is the operand's own.
 */
function refusal(
  ctx: CommandContext,
  operand: string,
  error: unknown,
): { name: string; reason: string } {
  for (const name of ancestors(operand)) {
    const path = absolutePath(ctx.cwd, name);
    const stat = statOrError(path);
    if ("error" in stat) {
      const missing = errnoCodeOf(stat.error) === "ENOENT";
      return { name, reason: errorText(missing ? error : stat.error) };
    }
    if (!isDir(stat)) {
      return { name, reason: errnoText("ENOTDIR") };
    }
    try {
      ctx.fs.access(path, X_OK);
    } catch (accessError) {
      return { name, reason: errorText(accessError) };
    }
  }
  return { name: operand, reason: errorText(error) };
}

/** What its owner needs on a directory to make another in it: write and search. */
const OWNER_WX = 0o300;

/**
 * Makes the directories `operand` goes through that are not there yet, as
 * GNU mkdir -p makes them: with a=rwx less the mask, and with the owner's
 * write and search whatever the mask says, so that the next directory can be
 * made inside. One that is there, or a link to one, is passed over.
 */
function makeAncestors(ctx: CommandContext, operand: string): void {
  const fs = ctx.fs;
  for (const name of ancestors(operand)) {
    const path = absolutePath(ctx.cwd, name);
    try {
      fs.mkdir(path, false, 0o777);
    } catch (error) {
      const there = errnoCodeOf(error) === "EEXIST" ? tryStat(path) : null;
      if (there !== null && isDir(there)) {
        continue;
      }
      throw error;
    }
    const made = fs.stat(path, true).mode & 0o7777;
    if ((made & OWNER_WX) !== OWNER_WX) {
      fs.chmod(path, made | OWNER_WX, true);
    }
  }
}

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
  // -m sets the mode exactly, as chmod would; without it, a=rwx less the umask.
  const mode =
    typeof modeText === "string" && /^[0-7]+$/.test(modeText) ? parseInt(modeText, 8) : null;
  const fs = ctx.fs;
  let status = 0;
  for (const operand of parsed.operands) {
    const path = absolutePath(ctx.cwd, operand);
    // -v names every directory made: with -p, those not there beforehand.
    const made = !parsed.flags.has("v")
      ? []
      : !parents
        ? [operand]
        : [...ancestors(operand), operand].filter(
            (name) => tryStat(absolutePath(ctx.cwd, name)) === null,
          );
    try {
      // The parents get the default mode, so that -m 555 cannot keep -p
      // from making the rest; only the operand gets -m (as GNU mkdir does).
      if (parents) {
        makeAncestors(ctx, operand);
      }
      fs.mkdir(path, false, 0o777);
      if (mode !== null) {
        fs.chmod(path, mode, true);
      }
      ctx.io.out(made.map((name) => `mkdir: created directory '${name}'\n`).join(""));
    } catch (error) {
      // -p accepts a directory that exists, not a file in its place.
      const existing = parents && errnoCodeOf(error) === "EEXIST" ? tryStat(path) : null;
      if (existing && isDir(existing)) {
        continue;
      }
      const { name, reason } = parents
        ? refusal(ctx, operand, error)
        : { name: operand, reason: errorText(error) };
      ctx.io.err(`mkdir: cannot create directory '${name}': ${reason}\n`);
      status = 1;
    }
  }
  return status;
};
