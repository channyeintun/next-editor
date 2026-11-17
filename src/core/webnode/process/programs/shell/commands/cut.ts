// `cut -f list [-d delim] [-s]` and `cut -c list` / `-b list`.
import type { Command } from "../context";
import { inputLines, writeText } from "./lines";
import { options } from "./util";

/** Parses a cut list (`1,3-5,-2,4-`) into a membership test. */
export function parseList(spec: string): ((n: number) => boolean) | null {
  const ranges: [number, number][] = [];
  for (const part of spec.split(",")) {
    const match = /^(\d*)(-?)(\d*)$/.exec(part);
    if (!match || (match[1] === "" && match[3] === "")) {
      return null;
    }
    const start = match[1] === "" ? 1 : Number(match[1]);
    const end = match[2] === "" ? start : match[3] === "" ? Infinity : Number(match[3]);
    if (start < 1) {
      return null;
    }
    ranges.push([start, end]);
  }
  return (n) => ranges.some(([start, end]) => n >= start && n <= end);
}

/** `cut`. */
export const cut: Command = async (ctx, args) => {
  const parsed = options(ctx, args, {
    flags: "sn",
    values: "fdcb",
    long: {
      "fields=": "f",
      "delimiter=": "d",
      "characters=": "c",
      "bytes=": "b",
      "only-delimited": "s",
      "output-delimiter=": "D",
    },
  });
  if (!parsed) {
    return 1;
  }
  const fields = parsed.flags.get("f");
  const chars = parsed.flags.get("c") ?? parsed.flags.get("b");
  const spec = typeof fields === "string" ? fields : typeof chars === "string" ? chars : null;
  if (spec === null) {
    ctx.io.err("cut: you must specify a list of bytes, characters, or fields\n");
    return 1;
  }
  const member = parseList(spec);
  if (!member) {
    ctx.io.err(`cut: invalid field range: '${spec}'\n`);
    return 1;
  }
  const delimiterOption = parsed.flags.get("d");
  const delimiter = typeof delimiterOption === "string" ? delimiterOption : "\t";
  if (delimiter.length !== 1) {
    ctx.io.err("cut: the delimiter must be a single character\n");
    return 1;
  }
  const outputDelimiterOption = parsed.flags.get("D");
  const outputDelimiter =
    typeof outputDelimiterOption === "string" ? outputDelimiterOption : delimiter;
  // Each line is cut as it arrives.
  let failed = false;
  for await (const batch of inputLines(ctx, parsed.operands)) {
    if ("error" in batch) {
      ctx.io.err(`cut: ${batch.error}\n`);
      failed = true;
      continue;
    }
    let out = "";
    for (const line of batch.lines) {
      if (typeof fields === "string") {
        if (!line.includes(delimiter)) {
          if (!parsed.flags.has("s")) {
            out += `${line}\n`;
          }
          continue;
        }
        out += `${line
          .split(delimiter)
          .filter((_, index) => member(index + 1))
          .join(outputDelimiter)}\n`;
      } else {
        out += `${Array.from(line)
          .filter((_, index) => member(index + 1))
          .join("")}\n`;
      }
    }
    if (!writeText(ctx, out)) {
      break;
    }
  }
  return failed ? 1 : 0;
};
