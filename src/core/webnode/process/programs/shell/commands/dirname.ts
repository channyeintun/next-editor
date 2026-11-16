// `dirname names…`.
import type { Command } from "../context";
import { dirName } from "./util";

/** `dirname`. */
export const dirname: Command = (ctx, args) => {
  const names = args.filter((arg) => arg !== "--");
  if (names.length === 0) {
    ctx.io.err("dirname: missing operand\n");
    return 1;
  }
  ctx.io.out(names.map((name) => `${dirName(name)}\n`).join(""));
  return 0;
};
