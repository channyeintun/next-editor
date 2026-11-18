// `mv [-fnv] source… dest`.
import { errnoCodeOf } from "../../../../errors";
import { runtime } from "../../../runtime";
import type { Command } from "../context";
import {
  absolutePath,
  baseName,
  errorText,
  isDir,
  options,
  sameFile,
  statOrError,
  targetInDirectory,
} from "./util";

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
  const interactive = parsed.flags.has("i") && !parsed.flags.has("f");
  if (operands.length < 2) {
    ctx.io.err(
      operands.length === 0
        ? "mv: missing file operand\n"
        : `mv: missing destination file operand after '${operands[0]}'\n`,
    );
    return 1;
  }
  const dest = operands[operands.length - 1];
  const destPath = absolutePath(ctx.cwd, dest);
  const destFound = statOrError(destPath);
  const sources = operands.slice(0, -1);
  const intoDir = !("error" in destFound) && isDir(destFound) && !parsed.flags.has("T");
  if (sources.length > 1 && !intoDir) {
    // Why the last operand is no directory to move into.
    const reason = "error" in destFound ? errorText(destFound.error) : "Not a directory";
    ctx.io.err(`mv: target '${dest}': ${reason}\n`);
    return 1;
  }
  let status = 0;
  for (const source of sources) {
    const from = absolutePath(ctx.cwd, source);
    const to = intoDir ? `${destPath}/${baseName(source)}` : destPath;
    // What the messages name: the computed target, as GNU mv does.
    const target = intoDir ? targetInDirectory(dest, source) : dest;
    const found = statOrError(from, false);
    if ("error" in found) {
      ctx.io.err(`mv: cannot stat '${source}': ${errorText(found.error)}\n`);
      status = 1;
      continue;
    }
    // What is at the target now. One it may not look at is refused, as GNU
    // mv refuses it; the same file under another spelling is not moved.
    const existing = statOrError(to, false);
    const replaces = !("error" in existing);
    if (!replaces && errnoCodeOf(existing.error) !== "ENOENT") {
      ctx.io.err(`mv: cannot stat '${target}': ${errorText(existing.error)}\n`);
      status = 1;
      continue;
    }
    if (replaces && sameFile(found, existing)) {
      ctx.io.err(`mv: '${source}' and '${target}' are the same file\n`);
      status = 1;
      continue;
    }
    if (parsed.flags.has("n") && replaces) {
      continue;
    }
    // A directory and a file never replace each other.
    if (replaces && isDir(found) !== isDir(existing)) {
      ctx.io.err(
        isDir(found)
          ? `mv: cannot overwrite non-directory '${target}' with directory '${source}'\n`
          : `mv: cannot overwrite directory '${target}' with non-directory '${source}'\n`,
      );
      status = 1;
      continue;
    }
    // -i would ask before overwriting; a script here cannot answer, so refuse
    // rather than overwrite. -f overrides it.
    if (interactive && replaces) {
      ctx.io.err(`mv: not overwriting '${target}': -i cannot ask for confirmation here\n`);
      status = 1;
      continue;
    }
    try {
      runtime().fs.rename(from, to);
      if (parsed.flags.has("v")) {
        ctx.io.out(`renamed '${source}' -> '${target}'\n`);
      }
    } catch (error) {
      const code = errnoCodeOf(error);
      // rename(2) answers EINVAL for a directory moved into its own tree, and
      // ENOTEMPTY for one moved onto a directory that holds something.
      ctx.io.err(
        code === "EINVAL" && isDir(found)
          ? `mv: cannot move '${source}' to a subdirectory of itself, '${target}'\n`
          : code === "ENOTEMPTY" || code === "EEXIST"
            ? `mv: cannot overwrite '${target}': ${errorText(error)}\n`
            : `mv: cannot move '${source}' to '${target}': ${errorText(error)}\n`,
      );
      status = 1;
    }
  }
  return status;
};
