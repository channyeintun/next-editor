// `head [-n N] [-c N] [files…]` (also `-N`); standard input stops being read
// once enough has arrived, so `long-running | head -1` finishes.
import type { Command, CommandContext } from "../context";
import { ReadInterrupted } from "../io";
import { closedStandardInput, errnoText, inputError, inputs, options } from "./util";
import type { InputError } from "./util";

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

/** What GNU head reads at a time (BUFSIZ). */
const READ_SIZE = 8192;

/**
 * The head of standard input, read as GNU head reads it, which decides what
 * the next reader of the input gets: `-c N` reads no more than N bytes;
 * `-n N` reads 8 KiB at a time and gives back what it read past the last
 * line on a file (GNU seeks back) but not on a pipe, where it is lost.
 * A failed read ends it: what it read before is printed, and the failure
 * returned.
 */
async function headOfStdin(
  ctx: CommandContext,
  lines: number | null,
  bytes: number | null,
): Promise<InputError | null> {
  // Nothing to print: read nothing, or the first line would slip through below.
  if (lines === 0 || bytes === 0) {
    return null;
  }
  let failure: InputError | null = null;
  const collected: number[] = [];
  let newlines = 0;
  for (;;) {
    const size = bytes === null ? READ_SIZE : Math.min(READ_SIZE, bytes - collected.length);
    let chunk: Uint8Array;
    try {
      chunk = await ctx.io.readChunk(size);
    } catch (error) {
      if (error instanceof ReadInterrupted) {
        throw error;
      }
      failure = inputError("-", error);
      break;
    }
    if (chunk.length === 0) {
      break;
    }
    let used = 0;
    for (const byte of chunk) {
      if (bytes !== null && collected.length >= bytes) {
        break;
      }
      collected.push(byte);
      used++;
      if (byte === 10) {
        newlines++;
        if (lines !== null && newlines >= lines) {
          break;
        }
      }
    }
    if ((bytes !== null && collected.length >= bytes) || (lines !== null && newlines >= lines)) {
      ctx.io.unreadInput(chunk.subarray(used));
      break;
    }
  }
  ctx.io.out(Uint8Array.from(collected));
  return failure;
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
  let inputClosed = false;
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    if (headers) {
      ctx.io.out(`${index > 0 ? "\n" : ""}==> ${file === "-" ? "standard input" : file} <==\n`);
    }
    if (file === "-" && !spec.allBut) {
      const failure = await headOfStdin(
        ctx,
        byBytes ? null : spec.count,
        byBytes ? spec.count : null,
      );
      if (failure !== null) {
        ctx.io.err(`head: error reading 'standard input': ${failure.error}\n`);
        inputClosed ||= closedStandardInput(failure);
        status = 1;
      }
      continue;
    }
    for await (const input of inputs(ctx, [file])) {
      if ("error" in input && closedStandardInput(input)) {
        // To leave off its last part, GNU head first looks at what the input is.
        ctx.io.err(`head: cannot fstat 'standard input': ${input.error}\n`);
        inputClosed = true;
        status = 1;
        continue;
      }
      if ("error" in input) {
        ctx.io.err(`head: cannot open '${file}' for reading: ${input.error}\n`);
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
      // Cut at a newline in the bytes themselves, so bytes that are not
      // UTF-8 pass through unchanged.
      const ends: number[] = [];
      for (let at = data.indexOf(10); at >= 0; at = data.indexOf(10, at + 1)) {
        ends.push(at + 1);
      }
      // A last line without a newline counts as a line too.
      if (data.length > 0 && data[data.length - 1] !== 10) {
        ends.push(data.length);
      }
      const keep = spec.allBut ? Math.max(0, ends.length - spec.count) : spec.count;
      ctx.io.out(data.subarray(0, keep === 0 ? 0 : (ends[Math.min(keep, ends.length) - 1] ?? 0)));
    }
  }
  if (inputClosed) {
    // GNU head closes standard input at its end, which fails again.
    ctx.io.err(`head: -: ${errnoText("EBADF")}\n`);
  }
  return status;
};
