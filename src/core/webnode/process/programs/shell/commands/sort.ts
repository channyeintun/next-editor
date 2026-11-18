// `sort [-rnufVbhgs] [-t sep] [-k N[,M][opts]]… [-o file] [files…]`.
import { O_CREAT, O_TRUNC, O_WRONLY, R_OK } from "../../../../kernel/vfs/types";
import type { Command } from "../context";
import { descriptorOf } from "../io";
import { encodeText, inputLines, writeText } from "./lines";
import { absolutePath, closedStandardInput, errorText, options, quoteName } from "./util";

/** One `-k` key: fields `start` to `end` and its ordering letters (n r f b V h g). */
interface SortKey {
  start: number;
  end: number | null;
  options: string;
}

function keyOf(line: string, key: SortKey, separator: string | null): string {
  const fields = separator === null ? line.trim().split(/\s+/) : line.split(separator);
  const end = key.end === null ? fields.length : key.end;
  return fields.slice(key.start - 1, end).join(separator ?? " ");
}

/** Every `-k` value in order; the option parser keeps only the last. */
function keyTexts(args: string[]): string[] {
  const texts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      break;
    }
    if (arg.startsWith("--")) {
      if (arg.startsWith("--key=")) {
        texts.push(arg.slice(6));
      } else if (/^--(key|field-separator|output)$/.test(arg)) {
        const value = args[++i];
        if (arg === "--key" && value !== undefined) {
          texts.push(value);
        }
      }
      continue;
    }
    if (!arg.startsWith("-") || arg.length < 2) {
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      if ("tko".includes(arg[j])) {
        const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
        if (arg[j] === "k" && value !== undefined) {
          texts.push(value);
        }
        break;
      }
    }
  }
  return texts;
}

const HUMAN = "KMGTPEZY";

/** The number a key starts with; with -h a K/M/G… suffix scales it. */
function numberOf(text: string, human: boolean): number {
  const match = /^\s*([-+]?(?:\d+\.?\d*|\.\d+))([a-zA-Z]?)/.exec(text);
  if (!match) {
    return 0;
  }
  const value = Number(match[1]);
  const scale = human && match[2] !== "" ? HUMAN.indexOf(match[2].toUpperCase()) + 1 : 0;
  return value * 1024 ** scale;
}

/** Compares two keys by the ordering letters in `options` (without `r`). */
function compareBy(ka: string, kb: string, options: string): number {
  if (options.includes("b")) {
    ka = ka.trimStart();
    kb = kb.trimStart();
  }
  if (/[nhg]/.test(options)) {
    const na = numberOf(ka, options.includes("h"));
    const nb = numberOf(kb, options.includes("h"));
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  if (options.includes("V")) {
    return ka.localeCompare(kb, undefined, { numeric: true });
  }
  if (options.includes("f")) {
    ka = ka.toUpperCase();
    kb = kb.toUpperCase();
  }
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** `sort`. */
export const sort: Command = async (ctx, args) => {
  const parsed = options(ctx, args, {
    flags: "rnufVbhgs",
    values: "tko",
    long: {
      reverse: "r",
      "numeric-sort": "n",
      unique: "u",
      "ignore-case": "f",
      "version-sort": "V",
      "human-numeric-sort": "h",
      "general-numeric-sort": "g",
      "ignore-leading-blanks": "b",
      stable: "s",
      "field-separator=": "t",
      "key=": "k",
      "output=": "o",
    },
  });
  if (!parsed) {
    return 2;
  }
  const f = (flag: string): boolean => parsed.flags.has(flag);
  const separator =
    typeof parsed.flags.get("t") === "string" ? (parsed.flags.get("t") as string) : null;
  const global = Array.from("nrfVbhg")
    .filter((flag) => f(flag))
    .join("");
  // Every key keeps its own letters; a key without any takes the global ones
  // (GNU and BSD). Keys are compared in order, then the whole line.
  const keys: SortKey[] = [];
  for (const keyText of keyTexts(args)) {
    const match = /^(\d+)(?:\.\d+)?([a-zA-Z]*)(?:,(\d+)(?:\.\d+)?([a-zA-Z]*))?$/.exec(keyText);
    if (!match || Number(match[1]) < 1 || /[^bdfghinMRrV]/.test(match[2] + (match[4] ?? ""))) {
      ctx.io.err(`sort: invalid key: '${keyText}'\n`);
      return 2;
    }
    const own = match[2] + (match[4] ?? "");
    keys.push({
      start: Number(match[1]),
      end: match[3] ? Number(match[3]) : null,
      options: own === "" ? global : own,
    });
  }
  if (keys.length === 0) {
    keys.push({ start: 1, end: null, options: global });
  }
  const whole =
    keys.length === 1 && keys[0].start === 1 && keys[0].end === null && separator === null;
  // As GNU sort: every input must be readable and the output file must open
  // before anything is read, and any failure ends it (exit 2) with no output.
  const fs = ctx.fs;
  for (const file of parsed.operands) {
    // Standard input, or another of sort's own fds (/dev/stdin), is read when its turn comes.
    if (file === "-" || descriptorOf(file) !== null) {
      continue;
    }
    try {
      fs.access(absolutePath(ctx.cwd, file), R_OK);
    } catch (error) {
      ctx.io.err(`sort: cannot read: ${quoteName(file)}: ${errorText(error)}\n`);
      return 2;
    }
  }
  const outputFile = parsed.flags.get("o");
  let outputPath: string | null = null;
  if (typeof outputFile === "string") {
    outputPath = absolutePath(ctx.cwd, outputFile);
    try {
      // Not truncated yet: the output file may be one of the inputs.
      fs.close(fs.open(outputPath, O_WRONLY | O_CREAT, 0o666));
    } catch (error) {
      ctx.io.err(`sort: open failed: ${quoteName(outputFile)}: ${errorText(error)}\n`);
      return 2;
    }
  }
  const lines: string[] = [];
  for await (const batch of inputLines(ctx, parsed.operands)) {
    if ("error" in batch) {
      // GNU sort looks at standard input before it reads it.
      const failed = closedStandardInput(batch) ? "stat failed" : "read failed";
      ctx.io.err(`sort: ${failed}: ${quoteName(batch.name)}: ${batch.error}\n`);
      return 2;
    }
    // One at a time: a file is one batch of all its lines, more than a call
    // can take as arguments.
    for (const line of batch.lines) {
      lines.push(line);
    }
  }
  const compareKeys = (a: string, b: string): number => {
    for (const key of keys) {
      const result = compareBy(
        whole ? a : keyOf(a, key, separator),
        whole ? b : keyOf(b, key, separator),
        key.options,
      );
      if (result !== 0) {
        return key.options.includes("r") ? -result : result;
      }
    }
    return 0;
  };
  const compare = (a: string, b: string): number => {
    const result = compareKeys(a, b);
    if (result !== 0 || f("u") || f("s")) {
      return result;
    }
    const last = a < b ? -1 : a > b ? 1 : 0;
    return f("r") ? -last : last;
  };
  lines.sort(compare);
  let out = lines;
  if (f("u")) {
    out = lines.filter((line, index) => index === 0 || compareKeys(lines[index - 1], line) !== 0);
  }
  const text = out.map((line) => `${line}\n`).join("");
  if (outputPath !== null) {
    fs.writeFile(outputPath, encodeText(text), O_WRONLY | O_CREAT | O_TRUNC, 0o666);
    return 0;
  }
  writeText(ctx, text);
  return 0;
};
