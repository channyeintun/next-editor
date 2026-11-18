// What a built-in file or text command (commands/*.ts) gets to work with, and
// the control-flow signals the interpreter throws for `exit`, `return`,
// `break` and `continue`, and Ctrl+C at an interactive shell.
import type { FsBackend } from "../../runtime";
import type { CommandIo } from "./io";

/** Everything an in-process command may use. */
export interface CommandContext {
  /** The name it was invoked as. */
  name: string;
  /** The shell's working directory. */
  cwd: string;
  /**
   * The filesystem as the command's shell has it: what the command creates
   * through it gets the shell's file mode creation mask, which in a subshell
   * is not the process's (umask.ts). A command makes its files and
   * directories through this one.
   */
  fs: FsBackend;
  /** The environment the command sees (exported variables plus prefix assignments). */
  env: Record<string, string>;
  io: CommandIo;
  /** Aborted when the shell receives SIGINT or SIGTERM. */
  signal: AbortSignal;
  /**
   * Runs another command (builtin, built-in command or external) with this
   * command's I/O. `env` adds variables, or with `replaceEnv` is the whole
   * environment.
   */
  exec(argv: string[], env?: Record<string, string>, replaceEnv?: boolean): Promise<number>;
}

/** An in-process command: returns its exit status. */
export type Command = (ctx: CommandContext, args: string[]) => number | Promise<number>;

/** `exit` (or a fatal error): unwinds to the shell (or subshell) top. */
export class ExitSignal {
  readonly status: number;
  /**
   * The signal the shell ends of, as a process ends of a signal it does not
   * handle: one that reached the shell (bash re-raises it), or the one that
   * ended a program it ran as its last act (`exec`, a lone `sh -c` command).
   * A subshell takes only `status`.
   */
  readonly signal: string | null;
  constructor(status: number, signal: string | null = null) {
    this.status = status;
    this.signal = signal;
  }
}

/** `return` from a function or sourced file. */
export class ReturnSignal {
  readonly status: number;
  constructor(status: number) {
    this.status = status;
  }
}

/** `break n` / `continue n`. */
export class LoopSignal {
  readonly kind: "break" | "continue";
  levels: number;
  constructor(kind: "break" | "continue", levels: number) {
    this.kind = kind;
    this.levels = levels;
  }
}

/**
 * Ctrl+C in an interactive shell while it runs commands of its own (a loop of
 * builtins): abandons the command line and returns to the prompt.
 */
export class InterruptSignal {}
