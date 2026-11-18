// `wc [-lwcm] [files…]`.
import type { Command } from "../context";
import { decode } from "../io";
import { inputs, options, quoteName } from "./util";

/** `wc`. */
export const wc: Command = async (ctx, args) => {
  const parsed = options(ctx, args, {
    flags: "lwcmL",
    long: { lines: "l", words: "w", bytes: "c", chars: "m" },
  });
  if (!parsed) {
    return 1;
  }
  let columns = ["l", "w", "m", "c", "L"].filter((flag) => parsed.flags.has(flag));
  if (columns.length === 0) {
    columns = ["l", "w", "c"];
  }
  const rows: { name: string | null; counts: number[] }[] = [];
  const totals = columns.map(() => 0);
  let status = 0;
  const files = parsed.operands;
  for await (const input of inputs(ctx, files)) {
    if ("error" in input) {
      // GNU wc refuses an empty name before it looks for the file.
      ctx.io.err(
        input.name === ""
          ? "wc: invalid zero-length file name\n"
          : `wc: ${quoteName(input.name)}: ${input.error}\n`,
      );
      status = 1;
      continue;
    }
    const text = decode(input.data);
    const counts = columns.map((column) => {
      switch (column) {
        case "l":
          return (text.match(/\n/g) ?? []).length;
        case "w":
          return (text.match(/\S+/g) ?? []).length;
        case "m":
          return Array.from(text).length;
        case "L":
          return Math.max(0, ...text.split("\n").map((line) => Array.from(line).length));
        default:
          return input.data.length;
      }
    });
    counts.forEach((count, i) => {
      totals[i] = columns[i] === "L" ? Math.max(totals[i], count) : totals[i] + count;
    });
    rows.push({ name: files.length === 0 ? null : input.name, counts });
  }
  if (files.length > 1) {
    rows.push({ name: "total", counts: totals });
  }
  const single = rows.length === 1 && columns.length === 1 && rows[0].name === null;
  const width = single
    ? 0
    : Math.max(1, ...rows.flatMap((row) => row.counts.map((count) => String(count).length)));
  let out = "";
  for (const row of rows) {
    const cells = row.counts.map((count) => String(count).padStart(width));
    out += `${cells.join(" ")}${row.name === null ? "" : ` ${row.name}`}\n`;
  }
  ctx.io.out(out);
  return status;
};
