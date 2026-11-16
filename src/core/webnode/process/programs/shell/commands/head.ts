// `head [-n N] [-c N] [files…]` (also `-N`); standard input stops being read
// once enough has arrived, so `long-running | head -1` finishes.
import type { Command, CommandContext } from "../context";
import { decode, encode } from "../io";
import { inputs, options } from "./util";

function parseCount(
  value: string | true | undefined,
  fallback: number,
): { count: number; allBut: boolean } | null {
  if (value === undefined || value === true) {
    return { count: fallback, allBut: false };
  }
  const match = /^(-?)(\d+)([kKmM]?)$/.exec(value);
  if (!match) {
    return null;
  }
  const scale =
    match[3].toLowerCase() === "k" ? 1024 : match[3].toLowerCase() === "m" ? 1048576 : 1;
  return { count: Number(match[2]) * scale, allBut: match[1] === "-" };
}

async function headOfStdin(
  ctx: CommandContext,
  lines: number | null,
  bytes: number | null,
): Promise<void> {
  const collected: number[] = [];
  let newlines = 0;
  for (;;) {
    const chunk = await ctx.io.readChunk();
    if (chunk.length === 0) {
      break;
    }
    for (const byte of chunk) {
      if (bytes !== null && collected.length >= bytes) {
        break;
      }
      collected.push(byte);
      if (byte === 10) {
        newlines++;
        if (lines !== null && newlines >= lines) {
          break;
        }
      }
    }
    if ((bytes !== null && collected.length >= bytes) || (lines !== null && newlines >= lines)) {
      break;
    }
  }
  ctx.io.out(Uint8Array.from(collected));
}

/** `head`. */
export const head: Command = async (ctx, args) => {
  args = args.map((arg, index) =>
    /^-\d+$/.test(arg) && !(index > 0 && (args[index - 1] === "-n" || args[index - 1] === "-c"))
      ? `-n${arg.slice(1)}`
      : arg,
  );
  const parsed = options(ctx, args, {
    flags: "qv",
    values: "nc",
    long: { "lines=": "n", "bytes=": "c", quiet: "q" },
  });
  if (!parsed) {
    return 1;
  }
  const byBytes = parsed.flags.has("c");
  const spec = parseCount(byBytes ? parsed.flags.get("c") : parsed.flags.get("n"), 10);
  if (!spec) {
    ctx.io.err(`head: invalid number of ${byBytes ? "bytes" : "lines"}\n`);
    return 1;
  }
  const files = parsed.operands.length > 0 ? parsed.operands : ["-"];
  const headers = (files.length > 1 && !parsed.flags.has("q")) || parsed.flags.has("v");
  let status = 0;
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    if (headers) {
      ctx.io.out(`${index > 0 ? "\n" : ""}==> ${file === "-" ? "standard input" : file} <==\n`);
    }
    if (file === "-" && !spec.allBut) {
      await headOfStdin(ctx, byBytes ? null : spec.count, byBytes ? spec.count : null);
      continue;
    }
    for await (const input of inputs(ctx, [file])) {
      if ("error" in input) {
        ctx.io.err(
          `head: cannot open '${file}' for reading: ${input.error.replace(`${file}: `, "")}\n`,
        );
        status = 1;
        continue;
      }
      const data = input.data;
      if (byBytes) {
        ctx.io.out(
          spec.allBut
            ? data.subarray(0, Math.max(0, data.length - spec.count))
            : data.subarray(0, spec.count),
        );
        continue;
      }
      const text = decode(data);
      const lines = text.split("\n");
      const complete = text.endsWith("\n") ? lines.slice(0, -1) : lines;
      const keep = spec.allBut
        ? complete.slice(0, Math.max(0, complete.length - spec.count))
        : complete.slice(0, spec.count);
      let out = keep.join("\n");
      if (keep.length > 0 && (keep.length < complete.length || text.endsWith("\n"))) {
        out += "\n";
      }
      ctx.io.out(encode(out));
    }
  }
  return status;
};
