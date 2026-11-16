// `uniq [-c] [-d] [-u] [-i] [input [output]]`.
import type { Command } from "../context";
import { options, readTexts, splitLines } from "./util";

/** `uniq`. */
export const uniq: Command = async (ctx, args) => {
  const parsed = options(ctx, args, {
    flags: "cdui",
    long: { count: "c", repeated: "d", unique: "u", "ignore-case": "i" },
  });
  if (!parsed) {
    return 1;
  }
  if (parsed.operands.length > 1) {
    ctx.io.err("uniq: an output file operand: not supported\n");
    return 1;
  }
  const { texts, failed } = await readTexts(ctx, parsed.operands);
  if (failed) {
    return 1;
  }
  const lines = splitLines(texts[0]?.text ?? "");
  const same = (a: string, b: string): boolean =>
    parsed.flags.has("i") ? a.toLowerCase() === b.toLowerCase() : a === b;
  let out = "";
  for (let i = 0; i < lines.length;) {
    let j = i + 1;
    while (j < lines.length && same(lines[i], lines[j])) {
      j++;
    }
    const count = j - i;
    const show = parsed.flags.has("d") ? count > 1 : parsed.flags.has("u") ? count === 1 : true;
    if (show) {
      out += parsed.flags.has("c") ? `${String(count).padStart(7)} ${lines[i]}\n` : `${lines[i]}\n`;
    }
    i = j;
  }
  ctx.io.out(out);
  return 0;
};
