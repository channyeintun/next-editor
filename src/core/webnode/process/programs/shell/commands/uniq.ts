// `uniq [-c] [-d] [-u] [-i] [input [output]]`.
import type { Command } from "../context";
import { inputLines, writeText } from "./lines";
import { options, quoteName } from "./util";

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
  const same = (a: string, b: string): boolean =>
    parsed.flags.has("i") ? a.toLowerCase() === b.toLowerCase() : a === b;
  // A run of equal lines is written once a different line arrives (or the
  // input ends), so `tail -f log | uniq` keeps up.
  let current: string | null = null;
  let count = 0;
  const group = (): string => {
    if (current === null) {
      return "";
    }
    const show = parsed.flags.has("d") ? count > 1 : parsed.flags.has("u") ? count === 1 : true;
    if (!show) {
      return "";
    }
    return parsed.flags.has("c") ? `${String(count).padStart(7)} ${current}\n` : `${current}\n`;
  };
  for await (const batch of inputLines(ctx, parsed.operands)) {
    if ("error" in batch) {
      ctx.io.err(`uniq: ${quoteName(batch.name)}: ${batch.error}\n`);
      return 1;
    }
    let out = "";
    for (const line of batch.lines) {
      if (current !== null && same(current, line)) {
        count++;
        continue;
      }
      out += group();
      current = line;
      count = 1;
    }
    if (!writeText(ctx, out)) {
      return 0;
    }
  }
  writeText(ctx, group());
  return 0;
};
