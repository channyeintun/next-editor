// `sort [-rnufV] [-t sep] [-k N[,M]] [files…]`.
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../../../kernel/vfs/types";
import { runtime } from "../../../runtime";
import type { Command } from "../context";
import { encode } from "../io";
import { options, readTexts, splitLines } from "./util";

function keyOf(
  line: string,
  key: { start: number; end: number | null } | null,
  separator: string | null,
): string {
  if (!key) {
    return line;
  }
  const fields = separator === null ? line.trim().split(/\s+/) : line.split(separator);
  const end = key.end === null ? fields.length : key.end;
  return fields.slice(key.start - 1, end).join(separator ?? " ");
}

function versionCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/** `sort`. */
export const sort: Command = async (ctx, args) => {
  const parsed = options(ctx, args, {
    flags: "rnufVbhs",
    values: "tko",
    long: {
      reverse: "r",
      "numeric-sort": "n",
      unique: "u",
      "ignore-case": "f",
      "version-sort": "V",
      "field-separator=": "t",
      "key=": "k",
    },
  });
  if (!parsed) {
    return 2;
  }
  const f = (flag: string): boolean => parsed.flags.has(flag);
  const separator =
    typeof parsed.flags.get("t") === "string" ? (parsed.flags.get("t") as string) : null;
  let key: { start: number; end: number | null } | null = null;
  const keyText = parsed.flags.get("k");
  let numericKey = false;
  if (typeof keyText === "string") {
    const match = /^(\d+)(?:\.\d+)?([a-z]*)(?:,(\d+)(?:\.\d+)?([a-z]*))?$/.exec(keyText);
    if (!match) {
      ctx.io.err(`sort: invalid key: '${keyText}'\n`);
      return 2;
    }
    key = { start: Number(match[1]), end: match[3] ? Number(match[3]) : null };
    numericKey = (match[2] ?? "").includes("n") || (match[4] ?? "").includes("n");
  }
  const { texts, failed } = await readTexts(ctx, parsed.operands);
  const lines = texts.flatMap((input) => splitLines(input.text));
  const numeric = f("n") || numericKey || f("h");
  const compare = (a: string, b: string): number => {
    const ka = keyOf(a, key, separator);
    const kb = keyOf(b, key, separator);
    let result: number;
    if (numeric) {
      const na = parseFloat(ka) || 0;
      const nb = parseFloat(kb) || 0;
      result = na === nb ? 0 : na < nb ? -1 : 1;
    } else if (f("V")) {
      result = versionCompare(ka, kb);
    } else {
      const ca = f("f") ? ka.toUpperCase() : ka;
      const cb = f("f") ? kb.toUpperCase() : kb;
      result = ca < cb ? -1 : ca > cb ? 1 : 0;
    }
    if (result === 0 && !f("u") && !f("s")) {
      result = a < b ? -1 : a > b ? 1 : 0;
    }
    return f("r") ? -result : result;
  };
  lines.sort(compare);
  let out = lines;
  if (f("u")) {
    out = lines.filter((line, index) => index === 0 || compare(lines[index - 1], line) !== 0);
  }
  const text = out.map((line) => `${line}\n`).join("");
  const outputFile = parsed.flags.get("o");
  if (typeof outputFile === "string") {
    runtime().fs.writeFile(
      ctx.resolve(outputFile),
      encode(text),
      O_WRONLY | O_CREAT | O_TRUNC,
      0o666,
    );
    return failed ? 2 : 0;
  }
  ctx.io.out(text);
  return failed ? 2 : 0;
};
