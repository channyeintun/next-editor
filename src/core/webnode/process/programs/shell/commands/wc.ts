// `wc [-lwcm] [files…]`.
import type { Command } from "../context";
import { decode } from "../io";
import { closedStandardInput, errnoText, inputs, options, quoteName } from "./util";

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
  // `failure`: what is said on standard error after the row is printed.
  const rows: { name: string | null; counts: number[]; failure?: string }[] = [];
  const totals = columns.map(() => 0);
  let status = 0;
  let inputClosed = false;
  const files = parsed.operands;
  for await (const input of inputs(ctx, files)) {
    if ("error" in input && closedStandardInput(input)) {
      // GNU wc counts nothing of a standard input that is closed, prints
      // its row of zeros, then says why.
      const name = files.length === 0 ? null : input.name;
      const shown = name === null ? "'standard input'" : quoteName(name);
      rows.push({ name, counts: columns.map(() => 0), failure: `wc: ${shown}: ${input.error}\n` });
      inputClosed = true;
      status = 1;
      continue;
    }
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
    if (row.failure !== undefined) {
      ctx.io.out(out);
      ctx.io.err(row.failure);
      out = "";
    }
  }
  ctx.io.out(out);
  if (inputClosed) {
    // GNU wc closes standard input at its end, which fails again.
    ctx.io.err(`wc: -: ${errnoText("EBADF")}\n`);
  }
  return status;
};
