// `mv [-fnv] source… dest`.
import { runtime } from "../../../runtime";
import type { Command } from "../context";
import { baseName, errorText, isDir, options, tryStat } from "./util";

/** `mv`. */
export const mv: Command = (ctx, args) => {
  const parsed = options(ctx, args, {
    flags: "finvT",
    long: { force: "f", "no-clobber": "n", verbose: "v" },
  });
  if (!parsed) {
    return 1;
  }
  const { operands } = parsed;
  if (operands.length < 2) {
    ctx.io.err(
      operands.length === 0
        ? "mv: missing file operand\n"
        : `mv: missing destination file operand after '${operands[0]}'\n`,
    );
    return 1;
  }
  const dest = operands[operands.length - 1];
  const destPath = ctx.resolve(dest);
  const destStat = tryStat(destPath);
  const sources = operands.slice(0, -1);
  const intoDir = destStat !== null && isDir(destStat) && !parsed.flags.has("T");
  if (sources.length > 1 && !intoDir) {
    ctx.io.err(`mv: target '${dest}' is not a directory\n`);
    return 1;
  }
  let status = 0;
  for (const source of sources) {
    const from = ctx.resolve(source);
    const to = intoDir ? `${destPath}/${baseName(source)}` : destPath;
    if (!tryStat(from, false)) {
      ctx.io.err(`mv: cannot stat '${source}': No such file or directory\n`);
      status = 1;
      continue;
    }
    if (from === to) {
      ctx.io.err(`mv: '${source}' and '${dest}' are the same file\n`);
      status = 1;
      continue;
    }
    if (`${to}/`.startsWith(`${from}/`)) {
      ctx.io.err(`mv: cannot move '${source}' to a subdirectory of itself, '${dest}'\n`);
      status = 1;
      continue;
    }
    if (parsed.flags.has("n") && tryStat(to, false)) {
      continue;
    }
    try {
      runtime().fs.rename(from, to);
      if (parsed.flags.has("v")) {
        ctx.io.out(`renamed '${source}' -> '${intoDir ? `${dest}/${baseName(source)}` : dest}'\n`);
      }
    } catch (error) {
      ctx.io.err(`mv: cannot move '${source}' to '${dest}': ${errorText(error)}\n`);
      status = 1;
    }
  }
  return status;
};
