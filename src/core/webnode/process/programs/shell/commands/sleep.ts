// `sleep seconds[smhd]…`; SIGINT/SIGTERM cut it short.
import { signalExitStatus } from "../../../../signals";
import type { Command } from "../context";

/** `sleep`. */
export const sleep: Command = async (ctx, args) => {
  if (args.length === 0) {
    ctx.io.err("sleep: missing operand\n");
    return 1;
  }
  let total = 0;
  for (const arg of args) {
    const match = /^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/.exec(arg);
    if (!match) {
      if (arg === "infinity") {
        total = Infinity;
        continue;
      }
      ctx.io.err(`sleep: invalid time interval '${arg}'\n`);
      return 1;
    }
    const scale = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2] as "" | "s" | "m" | "h" | "d"];
    total += Number(match[1]) * scale;
  }
  const signal = ctx.signal;
  if (signal.aborted) {
    return signalExitStatus("SIGINT");
  }
  await new Promise<void>((resolve) => {
    const timer = Number.isFinite(total) ? setTimeout(done, total * 1000) : undefined;
    function done(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
  return signal.aborted ? signalExitStatus("SIGINT") : 0;
};
