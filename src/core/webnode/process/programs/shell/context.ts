// What a built-in file or text command (commands/*.ts) gets to work with, and
// the control-flow signals the interpreter throws for `exit`, `return`,
// `break` and `continue`.
import type { CommandIo } from "./io";

/** Everything an in-process command may use. */
export interface CommandContext {
  /** The name it was invoked as. */
  name: string;
  /** The shell's working directory. */
  cwd: string;
  /** The environment the command sees (exported variables plus prefix assignments). */
  env: Record<string, string>;
  io: CommandIo;
  /** Aborted when the shell receives SIGINT or SIGTERM. */
  signal: AbortSignal;
  /** Resolves `path` against `cwd`. */
  resolve(path: string): string;
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
  constructor(status: number) {
    this.status = status;
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
