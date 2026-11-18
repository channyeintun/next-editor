// Test support for the text filters: runs one command directly with a
// standard input the test feeds piece by piece and a standard output the test
// can close, to check that a filter writes as its input arrives and stops
// reading once nobody reads its output.
import { runtime } from "../../../runtime";
import type { Command, CommandContext } from "../context";
import type { CommandIo } from "../io";

export interface FilterRun {
  /** Adds input; null ends it. */
  feed(text: string | null): void;
  /** What the command has written so far. */
  output(): string;
  /** Closes standard output: the next write fails as a broken pipe would. */
  closeOutput(): void;
  /** The command's exit status, once it returns. */
  done: Promise<number>;
  /** True once the command has returned. */
  finished(): boolean;
}

/** Waits for the command to act on what it was given. */
export function settle(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Starts `command args` with fed standard input (cwd /work) and returns its handle. */
export function runFilter(
  command: Command,
  args: string[],
  exec: CommandContext["exec"] = async () => 0,
): FilterRun {
  const pending: (Uint8Array | null)[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const written: Uint8Array[] = [];
  let closed = false;
  let finished = false;
  const io = {
    broken: false,
    out(data: string | Uint8Array): boolean {
      if (closed) {
        io.broken = true;
        return false;
      }
      written.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
      return true;
    },
    err(): boolean {
      return true;
    },
    isTty(): boolean {
      return false;
    },
    async readChunk(): Promise<Uint8Array> {
      while (pending.length === 0 && !ended) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const next = pending.shift();
      if (next === null || next === undefined) {
        ended = true;
        return new Uint8Array(0);
      }
      return next;
    },
  };
  const ctx: CommandContext = {
    name: "filter",
    cwd: "/work",
    // Read when a command asks: a filter that opens no file needs no runtime.
    get fs() {
      return runtime().fs;
    },
    env: {},
    io: io as unknown as CommandIo,
    signal: new AbortController().signal,
    exec,
  };
  const done = Promise.resolve(command(ctx, args)).then((status) => {
    finished = true;
    return status;
  });
  return {
    feed(text) {
      pending.push(text === null ? null : new TextEncoder().encode(text));
      wake?.();
      wake = null;
    },
    output() {
      return new TextDecoder().decode(
        Uint8Array.from(written.flatMap((chunk) => Array.from(chunk))),
      );
    },
    closeOutput() {
      closed = true;
    },
    done,
    finished: () => finished,
  };
}
