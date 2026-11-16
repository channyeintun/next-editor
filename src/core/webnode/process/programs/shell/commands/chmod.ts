// `chmod [-R] mode files…`: octal modes and symbolic ones (`u+x`, `go-w`, `a=r`, `+x`).
import { runtime } from "../../../runtime";
import type { Command } from "../context";
import { errorText, isDir, tryStat } from "./util";

/** Applies an octal or symbolic mode to `current`; null when the mode is invalid. */
export function applyMode(spec: string, current: number, directory: boolean): number | null {
  if (/^[0-7]{1,4}$/.test(spec)) {
    return parseInt(spec, 8);
  }
  let mode = current & 0o7777;
  for (const clause of spec.split(",")) {
    const match = /^([ugoa]*)((?:[-+=][rwxXst]*)+)$/.exec(clause);
    if (!match) {
      return null;
    }
    const who = match[1] === "" || match[1].includes("a") ? "ugo" : match[1];
    const masks = { u: 0o700, g: 0o070, o: 0o007 };
    let whoMask = 0;
    for (const w of who) {
      whoMask |= masks[w as "u" | "g" | "o"];
    }
    for (const action of match[2].match(/[-+=][rwxXst]*/g) ?? []) {
      const op = action[0];
      let bits = 0;
      for (const perm of action.slice(1)) {
        if (perm === "r") {
          bits |= 0o444;
        } else if (perm === "w") {
          bits |= 0o222;
        } else if (perm === "x" || (perm === "X" && (directory || (current & 0o111) !== 0))) {
          bits |= 0o111;
        } else if (perm === "s") {
          bits |= (who.includes("u") ? 0o4000 : 0) | (who.includes("g") ? 0o2000 : 0);
        } else if (perm === "t") {
          bits |= 0o1000;
        }
      }
      const special = bits & 0o7000;
      bits = (bits & whoMask) | special;
      if (op === "+") {
        mode |= bits;
      } else if (op === "-") {
        mode &= ~bits;
      } else {
        mode = (mode & ~whoMask) | bits;
      }
    }
  }
  return mode;
}

/** `chmod`. */
export const chmod: Command = (ctx, args) => {
  let recursive = false;
  const rest: string[] = [];
  for (const arg of args) {
    if (arg === "-R" || arg === "--recursive") {
      recursive = true;
    } else if (arg === "-v" || arg === "-f" || arg === "-c") {
      continue;
    } else {
      rest.push(arg);
    }
  }
  const [spec, ...files] = rest;
  if (spec === undefined || files.length === 0) {
    ctx.io.err(
      spec === undefined ? "chmod: missing operand\n" : `chmod: missing operand after '${spec}'\n`,
    );
    return 1;
  }
  const fs = runtime().fs;
  let status = 0;
  const visit = (path: string, label: string): void => {
    const stat = tryStat(path);
    if (!stat) {
      ctx.io.err(`chmod: cannot access '${label}': No such file or directory\n`);
      status = 1;
      return;
    }
    const mode = applyMode(spec, stat.mode, isDir(stat));
    if (mode === null) {
      ctx.io.err(`chmod: invalid mode: '${spec}'\n`);
      status = 1;
      return;
    }
    try {
      fs.chmod(path, mode, true);
    } catch (error) {
      ctx.io.err(`chmod: changing permissions of '${label}': ${errorText(error)}\n`);
      status = 1;
    }
    if (recursive && isDir(stat)) {
      for (const entry of fs.readdir(path)) {
        if (entry.type !== "symlink") {
          visit(`${path}/${entry.name}`, `${label}/${entry.name}`);
        }
      }
    }
  };
  for (const file of files) {
    visit(ctx.resolve(file), file);
  }
  return status;
};
