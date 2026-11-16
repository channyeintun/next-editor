// `basename name [suffix]`, `basename -a names…`, `basename -s suffix names…`.
import type { Command } from "../context";
import { baseName } from "./util";

/** `basename`. */
export const basename: Command = (ctx, args) => {
  let suffix = "";
  let multiple = false;
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-a") {
      multiple = true;
    } else if (args[i] === "-s") {
      suffix = args[++i] ?? "";
      multiple = true;
    } else {
      names.push(args[i]);
    }
  }
  if (names.length === 0) {
    ctx.io.err("basename: missing operand\n");
    return 1;
  }
  if (!multiple) {
    if (names.length > 2) {
      ctx.io.err(`basename: extra operand '${names[2]}'\n`);
      return 1;
    }
    suffix = names[1] ?? "";
    names.length = 1;
  }
  let out = "";
  for (const name of names) {
    let base = baseName(name);
    if (suffix && base !== suffix && base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
    }
    out += `${base}\n`;
  }
  ctx.io.out(out);
  return 0;
};
