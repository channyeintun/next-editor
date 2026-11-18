// `tail [-n [+]N] [-c [+]N] [-f] [files…]` (also `-N`). `-f` follows named
// files by looking at them every 250 ms; it is ignored for standard input.
import { runtime } from "../../../runtime";
import { signalExitStatus } from "../../../../signals";
import type { Command, CommandContext } from "../context";
import { absolutePath, closedStandardInput, errnoText, inputs, options, tryStat } from "./util";

/** How often `tail -f` looks at its files. */
const FOLLOW_INTERVAL_MS = 250;

/**
 * `tail -f`: prints what is appended to the files until the shell is
 * interrupted or nobody reads the output. A file that shrinks is read again
 * from its start, as GNU tail does after "file truncated".
 */
async function followFiles(ctx: CommandContext, files: string[], headers: boolean): Promise<void> {
  const fs = runtime().fs;
  const sizes = new Map<string, number>();
  for (const file of files) {
    sizes.set(file, tryStat(absolutePath(ctx.cwd, file))?.size ?? 0);
  }
  let shown = files[files.length - 1];
  const signal = ctx.signal;
  while (!signal.aborted && !ctx.io.broken) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, FOLLOW_INTERVAL_MS);
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done);
    });
    if (signal.aborted) {
      return;
    }
    for (const file of files) {
      const path = absolutePath(ctx.cwd, file);
      const stat = tryStat(path);
      const before = sizes.get(file) ?? 0;
      if (!stat || stat.size === before) {
        continue;
      }
      let from = before;
      if (stat.size < before) {
        ctx.io.err(`tail: ${file}: file truncated\n`);
        from = 0;
      }
      let data: Uint8Array;
      try {
        data = fs.readFile(path);
      } catch {
        continue;
      }
      sizes.set(file, data.length);
      if (data.length <= from) {
        continue;
      }
      if (headers && shown !== file) {
        ctx.io.out(`\n==> ${file} <==\n`);
        shown = file;
      }
      ctx.io.out(data.subarray(from));
    }
  }
}

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
  let inputClosed = false;
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    for await (const input of inputs(ctx, [file])) {
      if ("error" in input && closedStandardInput(input)) {
        // GNU tail looks at what standard input is first, below its header.
        if (headers) {
          ctx.io.out(`${index > 0 ? "\n" : ""}==> standard input <==\n`);
        }
        ctx.io.err(`tail: cannot fstat 'standard input': ${input.error}\n`);
        inputClosed = true;
        status = 1;
        continue;
      }
      if ("error" in input) {
        ctx.io.err(`tail: cannot open '${file}' for reading: ${input.error}\n`);
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
      // Cut at newlines in the bytes themselves, so bytes that are not
      // UTF-8 pass through unchanged.
      const starts = [0];
      for (
        let at = data.indexOf(10);
        at >= 0 && at + 1 < data.length;
        at = data.indexOf(10, at + 1)
      ) {
        starts.push(at + 1);
      }
      if (data.length === 0) {
        continue;
      }
      const first = fromStart
        ? Math.max(0, count - 1)
        : count === 0
          ? starts.length
          : Math.max(0, starts.length - count);
      if (first < starts.length) {
        ctx.io.out(data.subarray(starts[first]));
      }
    }
  }
  const follow = (parsed.flags.has("f") || parsed.flags.has("F")) && parsed.operands.length > 0;
  if (follow) {
    await followFiles(
      ctx,
      files.filter((file) => file !== "-"),
      headers,
    );
    return ctx.signal.aborted ? signalExitStatus("SIGINT") : status;
  }
  if (inputClosed) {
    // GNU tail closes standard input at its end, which fails again.
    ctx.io.err(`tail: -: ${errnoText("EBADF")}\n`);
  }
  return status;
};
