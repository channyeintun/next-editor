// `xargs [-n max] [-L lines] [-P procs] [-s size] [-I repl] [-0] [-d delim] [-r] [-t]
// [command [args…]]`. -P is accepted but the commands run one at a time.
import type { Command } from "../context";
import { shellQuote } from "../quote";
import { decodeText, inputLines } from "./lines";

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
  let maxLines: number | null = null;
  let replace: string | null = null;
  let delimiter: string | null = null;
  let noEmpty = false;
  let trace = false;
  /** The value of `-x N`, `-xN` or `--long=N`; null when `arg` is not that option. */
  const valueOf = (arg: string, letter: string, long: string): string | null | undefined => {
    if (arg === `-${letter}` || arg === `--${long}`) {
      return undefined;
    }
    if (arg.startsWith(`-${letter}`) && !arg.startsWith("--")) {
      return arg.slice(2);
    }
    if (arg.startsWith(`--${long}=`)) {
      return arg.slice(long.length + 3);
    }
    return null;
  };
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    let numeric: { letter: string; value: string | undefined } | null = null;
    for (const [letter, long] of [
      ["n", "max-args"],
      ["L", "max-lines"],
      ["P", "max-procs"],
      ["s", "max-chars"],
    ]) {
      const value = valueOf(arg, letter, long);
      if (value !== null) {
        numeric = { letter, value: value ?? args[++i] };
        break;
      }
    }
    if (numeric) {
      const count = Number(numeric.value);
      if (
        numeric.value === undefined ||
        !/^\d+$/.test(numeric.value) ||
        (count < 1 && numeric.letter !== "P")
      ) {
        ctx.io.err(
          `xargs: invalid number "${numeric.value ?? ""}" for -${numeric.letter} option\n`,
        );
        return 1;
      }
      if (numeric.letter === "n") {
        max = count;
        maxLines = null;
      } else if (numeric.letter === "L") {
        maxLines = count;
        max = Infinity;
      }
      // -P runs the commands one after another all the same; -s has no
      // limit to lower here.
    } else if (arg === "-I" || arg === "-i") {
      replace = arg === "-i" ? "{}" : (args[++i] ?? "{}");
    } else if (arg.startsWith("-I") && arg.length > 2) {
      replace = arg.slice(2);
    } else if (arg === "-0" || arg === "--null") {
      delimiter = "\0";
    } else if (arg === "-d") {
      delimiter = (args[++i] ?? "\n").replace("\\n", "\n").replace("\\t", "\t");
    } else if (arg === "-r" || arg === "--no-run-if-empty") {
      noEmpty = true;
    } else if (arg === "-t" || arg === "--verbose") {
      trace = true;
    } else if (arg.startsWith("-") && arg !== "-") {
      ctx.io.err(`xargs: ${arg}: not supported\n`);
      return 1;
    } else {
      break;
    }
  }
  const command = args.slice(i);
  if (command.length === 0) {
    command.push("echo");
  }
  let status = 0;
  let ran = false;
  /** Runs the command on one batch; a status to exit with at once (126, 127), else null. */
  const run = async (batch: string[]): Promise<number | null> => {
    ran = true;
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
    return null;
  };
  const pending: string[] = [];
  if (delimiter !== null) {
    const items = decodeText(await ctx.io.readAll()).split(delimiter);
    if (
      items[items.length - 1] === "" ||
      (delimiter === "\0" && items[items.length - 1] === "\n")
    ) {
      items.pop();
    }
    // One at a time: the input may hold more items than a call takes arguments.
    for (const item of items) {
      pending.push(item);
    }
  } else {
    // A command runs as soon as its batch is complete (one line for -I, N
    // lines for -L, N items for -n), so `watch | xargs -n1 cmd` keeps up.
    let lines = 0;
    for await (const batch of inputLines(ctx, [])) {
      if ("error" in batch) {
        continue;
      }
      for (const line of batch.lines) {
        if (replace !== null) {
          if (line.trim() !== "") {
            const early = await run([line]);
            if (early !== null) {
              return early;
            }
          }
          continue;
        }
        const items = splitXargs(line);
        if (items.length === 0) {
          continue;
        }
        for (const item of items) {
          pending.push(item);
        }
        lines++;
        if (maxLines !== null && lines >= maxLines) {
          const early = await run(pending.splice(0));
          lines = 0;
          if (early !== null) {
            return early;
          }
        }
        while (pending.length >= max) {
          const early = await run(pending.splice(0, max));
          if (early !== null) {
            return early;
          }
        }
      }
    }
  }
  if (replace !== null) {
    for (const item of pending.splice(0)) {
      const early = await run([item]);
      if (early !== null) {
        return early;
      }
    }
    return status;
  }
  while (pending.length > 0) {
    const early = await run(pending.splice(0, Number.isFinite(max) ? max : pending.length));
    if (early !== null) {
      return early;
    }
  }
  if (!ran && !noEmpty) {
    const early = await run([]);
    if (early !== null) {
      return early;
    }
  }
  return status;
};
