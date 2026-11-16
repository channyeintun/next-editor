// `tail [-n [+]N] [-c [+]N] [files…]` (also `-N`). `-f` is not supported.
import type { Command } from "../context";
import { decode, encode } from "../io";
import { inputs, options } from "./util";

/** `tail`. */
export const tail: Command = async (ctx, args) => {
  args = args.map((arg, index) => {
    const afterOption = index > 0 && (args[index - 1] === "-n" || args[index - 1] === "-c");
    if (afterOption) {
      return arg;
    }
    return /^-\d+$/.test(arg) ? `-n${arg.slice(1)}` : /^\+\d+$/.test(arg) ? `-n${arg}` : arg;
  });
  const parsed = options(ctx, args, {
    flags: "qvfF",
    values: "nc",
    long: { "lines=": "n", "bytes=": "c", follow: "f" },
  });
  if (!parsed) {
    return 1;
  }
  if (parsed.flags.has("f") || parsed.flags.has("F")) {
    ctx.io.err("tail: -f: not supported\n");
    return 1;
  }
  const byBytes = parsed.flags.has("c");
  const raw = byBytes ? parsed.flags.get("c") : parsed.flags.get("n");
  let count = 10;
  let fromStart = false;
  if (typeof raw === "string") {
    const match = /^([+-]?)(\d+)$/.exec(raw);
    if (!match) {
      ctx.io.err(`tail: invalid number of ${byBytes ? "bytes" : "lines"}: '${raw}'\n`);
      return 1;
    }
    fromStart = match[1] === "+";
    count = Number(match[2]);
  }
  const files = parsed.operands.length > 0 ? parsed.operands : ["-"];
  const headers = (files.length > 1 && !parsed.flags.has("q")) || parsed.flags.has("v");
  let status = 0;
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    for await (const input of inputs(ctx, [file])) {
      if ("error" in input) {
        ctx.io.err(
          `tail: cannot open '${file}' for reading: ${input.error.replace(`${file}: `, "")}\n`,
        );
        status = 1;
        continue;
      }
      if (headers) {
        ctx.io.out(`${index > 0 ? "\n" : ""}==> ${file === "-" ? "standard input" : file} <==\n`);
      }
      const data = input.data;
      if (byBytes) {
        ctx.io.out(
          fromStart
            ? data.subarray(Math.max(0, count - 1))
            : data.subarray(Math.max(0, data.length - count)),
        );
        continue;
      }
      const text = decode(data);
      const endsWithNewline = text.endsWith("\n");
      const lines = (endsWithNewline ? text.slice(0, -1) : text).split("\n");
      if (text === "") {
        continue;
      }
      const keep = fromStart
        ? lines.slice(Math.max(0, count - 1))
        : count === 0
          ? []
          : lines.slice(-count);
      if (keep.length === 0) {
        continue;
      }
      ctx.io.out(encode(keep.join("\n") + (endsWithNewline ? "\n" : "")));
    }
  }
  return status;
};
