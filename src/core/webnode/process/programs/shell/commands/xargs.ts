// `xargs [-n max] [-I repl] [-0] [-d delim] [-r] [-t] [command [args…]]`.
import type { Command } from "../context";
import { decode } from "../io";
import { shellQuote } from "../quote";

/** Splits xargs input on blanks and newlines, honouring quotes and backslashes. */
export function splitXargs(text: string): string[] {
  const items: string[] = [];
  let current = "";
  let has = false;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else {
        current += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      continue;
    }
    if (c === "\\" && i + 1 < text.length) {
      current += text[++i];
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has) {
        items.push(current);
        current = "";
        has = false;
      }
      continue;
    }
    current += c;
    has = true;
  }
  if (has) {
    items.push(current);
  }
  return items;
}

/** `xargs`. */
export const xargs: Command = async (ctx, args) => {
  let max = Infinity;
  let replace: string | null = null;
  let delimiter: string | null = null;
  let noEmpty = false;
  let trace = false;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-n") {
      max = Number(args[++i]);
    } else if (/^-n\d+$/.test(arg)) {
      max = Number(arg.slice(2));
    } else if (arg === "-I" || arg === "-i") {
      replace = arg === "-i" ? "{}" : (args[++i] ?? "{}");
      max = 1;
    } else if (arg.startsWith("-I") && arg.length > 2) {
      replace = arg.slice(2);
      max = 1;
    } else if (arg === "-0" || arg === "--null") {
      delimiter = "\0";
    } else if (arg === "-d") {
      delimiter = (args[++i] ?? "\n").replace("\\n", "\n").replace("\\t", "\t");
    } else if (arg === "-r" || arg === "--no-run-if-empty") {
      noEmpty = true;
    } else if (arg === "-t" || arg === "--verbose") {
      trace = true;
    } else if (arg === "-P" || arg === "-L" || arg === "-s") {
      i++;
    } else if (arg.startsWith("-") && arg !== "-") {
      ctx.io.err(`xargs: ${arg}: not supported\n`);
      return 1;
    } else {
      break;
    }
  }
  if (!Number.isFinite(max) && max !== Infinity) {
    ctx.io.err("xargs: invalid number for -n\n");
    return 1;
  }
  const command = args.slice(i);
  if (command.length === 0) {
    command.push("echo");
  }
  const text = decode(await ctx.io.readAll());
  let items: string[];
  if (replace !== null && delimiter === null) {
    items = text.split("\n").filter((line) => line.trim() !== "");
  } else if (delimiter !== null) {
    items = text.split(delimiter);
    if (
      items[items.length - 1] === "" ||
      (delimiter === "\0" && items[items.length - 1] === "\n")
    ) {
      items.pop();
    }
  } else {
    items = splitXargs(text);
  }
  if (items.length === 0 && (noEmpty || replace !== null)) {
    return 0;
  }
  const batches: string[][] = [];
  if (items.length === 0) {
    batches.push([]);
  }
  for (let start = 0; start < items.length; start += max) {
    batches.push(items.slice(start, start + max));
  }
  let status = 0;
  for (const batch of batches) {
    const argv =
      replace !== null
        ? command.map((arg) => arg.split(replace as string).join(batch[0] ?? ""))
        : [...command, ...batch];
    if (trace) {
      ctx.io.err(`${argv.map(shellQuote).join(" ")}\n`);
    }
    const result = await ctx.exec(argv);
    if (result === 127 || result === 126) {
      return result;
    }
    if (result !== 0) {
      status = 123;
    }
  }
  return status;
};
