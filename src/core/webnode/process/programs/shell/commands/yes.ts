// `yes [string…]`: writes the line (`y` by default) until nobody reads it.
import { signalExitStatus } from "../../../../signals";
import type { Command } from "../context";
import { encodeText } from "./lines";
import { errnoText } from "./util";

/** About how much each write holds: whole lines, as GNU yes fills its buffer. */
const BLOCK_SIZE = 8192;

/** Resolves in a later task, so a signal's message can be handled. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Resolves when `waiting` does, or as soon as `signal` aborts. */
function untilAborted(waiting: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = (): void => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done);
    void waiting.then(done);
  });
}

/**
 * `yes`. It ends when its output is closed (`yes | head -1`) or the shell is
 * interrupted. After each block it waits for the reader to take what is
 * queued, as a blocked write would (a signal ends the wait); where nothing
 * queues (a file, /dev/null) it lets one task run instead, so it never
 * holds the shell's worker.
 */
export const yes: Command = async (ctx, args) => {
  const line = `${args.length > 0 ? args.join(" ") : "y"}\n`;
  const block = encodeText(line.repeat(Math.max(1, Math.floor(BLOCK_SIZE / line.length))));
  while (!ctx.signal.aborted) {
    if (!ctx.io.out(block)) {
      break;
    }
    const settled = ctx.io.settle();
    await (settled ? untilAborted(settled, ctx.signal) : nextTask());
  }
  // In GNU yes's own words; a reader that went away is no error.
  const failed = ctx.io.takeWriteError();
  if (failed) {
    ctx.io.err(`yes: standard output: ${errnoText(failed.code)}\n`);
    return 1;
  }
  return ctx.signal.aborted ? signalExitStatus("SIGINT") : 0;
};
