// `cp [-rRfnpav] source… dest`: files, and directory trees with -r.
import { runtime } from "../../../runtime";
import type { Command } from "../context";
import { baseName, errorText, isDir, isLink, options, tryStat } from "./util";

function copyTree(from: string, to: string, noClobber: boolean): void {
  const fs = runtime().fs;
  const stat = fs.stat(from, false);
  if (isLink(stat)) {
    if (tryStat(to, false)) {
      if (noClobber) {
        return;
      }
      fs.unlink(to);
    }
    fs.symlink(fs.readlink(from), to);
    return;
  }
  if (isDir(stat)) {
    if (`${to}/`.startsWith(`${from}/`)) {
      throw new Error(`cannot copy a directory, '${from}', into itself, '${to}'`);
    }
    const existing = tryStat(to);
    if (!existing) {
      fs.mkdir(to, false, stat.mode & 0o7777);
    }
    for (const entry of fs.readdir(from)) {
      copyTree(`${from}/${entry.name}`, `${to}/${entry.name}`, noClobber);
    }
    return;
  }
  if (noClobber && tryStat(to)) {
    return;
  }
  fs.copyFile(from, to, 0);
  fs.chmod(to, stat.mode & 0o7777, true);
}

/** `cp`. */
export const cp: Command = (ctx, args) => {
  const parsed = options(ctx, args, {
    flags: "rRfnpavPLdT",
    long: {
      recursive: "r",
      force: "f",
      "no-clobber": "n",
      preserve: "p",
      archive: "a",
      verbose: "v",
    },
  });
  if (!parsed) {
    return 1;
  }
  const recursive = parsed.flags.has("r") || parsed.flags.has("R") || parsed.flags.has("a");
  const noClobber = parsed.flags.has("n");
  const { operands } = parsed;
  if (operands.length < 2) {
    ctx.io.err(
      operands.length === 0
        ? "cp: missing file operand\n"
        : `cp: missing destination file operand after '${operands[0]}'\n`,
    );
    return 1;
  }
  const dest = operands[operands.length - 1];
  const destPath = ctx.resolve(dest);
  const destStat = tryStat(destPath);
  const sources = operands.slice(0, -1);
  const intoDir = destStat !== null && isDir(destStat) && !parsed.flags.has("T");
  if (sources.length > 1 && !intoDir) {
    ctx.io.err(`cp: target '${dest}' is not a directory\n`);
    return 1;
  }
  let status = 0;
  for (const source of sources) {
    const from = ctx.resolve(source);
    const to = intoDir ? `${destPath}/${baseName(source)}` : destPath;
    const stat = tryStat(from);
    if (!stat) {
      ctx.io.err(`cp: cannot stat '${source}': No such file or directory\n`);
      status = 1;
      continue;
    }
    if (isDir(stat) && !recursive) {
      ctx.io.err(`cp: -r not specified; omitting directory '${source}'\n`);
      status = 1;
      continue;
    }
    if (from === to) {
      ctx.io.err(`cp: '${source}' and '${dest}' are the same file\n`);
      status = 1;
      continue;
    }
    try {
      if (isDir(stat)) {
        copyTree(from, to, noClobber);
      } else {
        if (noClobber && tryStat(to)) {
          continue;
        }
        runtime().fs.copyFile(from, to, 0);
        runtime().fs.chmod(to, stat.mode & 0o7777, true);
      }
      if (parsed.flags.has("v")) {
        ctx.io.out(`'${source}' -> '${intoDir ? `${dest}/${baseName(source)}` : dest}'\n`);
      }
    } catch (error) {
      ctx.io.err(
        `cp: ${error instanceof Error && !("code" in error) ? error.message : `cannot copy '${source}': ${errorText(error)}`}\n`,
      );
      status = 1;
    }
  }
  return status;
};
