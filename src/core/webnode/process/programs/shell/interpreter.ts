// The shell interpreter: variables, functions, options and traps; runs the
// syntax tree — lists, and-or chains, pipelines, compound commands,
// redirections — and dispatches each simple command to a function, a shell
// builtin, a built-in command (commands/) or an external process spawned
// through the kernel.
import { toSystemErrorRecord } from "../../../errors";
import { O_APPEND, O_CREAT, O_RDONLY, O_RDWR, O_TRUNC, O_WRONLY } from "../../../kernel/vfs/types";
import { runtime } from "../../runtime";
import type {
  AndOr,
  Assignment,
  Case,
  Command as AstCommand,
  CondExpr,
  FunctionDef,
  List,
  Pipeline,
  Program,
  Redirect,
  SimpleCommand,
  Word,
} from "./ast";
import { BUILTINS } from "./builtins";
import { COMMANDS } from "./commands/index";
import { binaryTest, unaryTest } from "./commands/test";
import { resolvePath } from "./commands/util";
import type { CommandContext } from "./context";
import { ExitSignal, InterruptSignal, LoopSignal, ReturnSignal } from "./context";
import {
  ExpansionError,
  arithmetic,
  expandPattern,
  expandString,
  expandWords,
  matchWord,
} from "./expand";
import type { ExpandContext } from "./expand";
import {
  CommandIo,
  baseFdTable,
  closeFd,
  decode,
  encode,
  isBrokenPipe,
  readAllAsync,
  trackFileOffset,
  writeFd,
} from "./io";
import type { FdTable } from "./io";
import { ShellSyntaxError } from "./lexer";
import { literalText, parse } from "./parser";
import { shellQuote } from "./quote";
import { signalNumber, statusOf } from "./signals";

/** A shell variable. */
export interface Variable {
  value: string;
  exported: boolean;
  readonly: boolean;
}

/** `set -o` options. */
export interface ShellOptions {
  errexit: boolean;
  xtrace: boolean;
  nounset: boolean;
  pipefail: boolean;
  noglob: boolean;
  noclobber: boolean;
  allexport: boolean;
  verbose: boolean;
}

/** A background job. */
export interface Job {
  id: number;
  /** A child's pid, or for a job run in this process a pid of its own (see `JobControl`). */
  pid: number | null;
  command: string;
  done: Promise<number>;
  status: number | null;
  /** Ends a job that runs in this process; absent for a child process (use the kernel). */
  kill?: (signal: string) => void;
}

/**
 * First pid given to a job that runs in this shell's process (`f &`,
 * `(cd api && node index.js) &`): above any pid the kernel hands out, so `$!`,
 * `kill` and `wait` can name the job.
 */
const FIRST_JOB_PID = 1 << 22;
let nextJobPid = FIRST_JOB_PID;

/** How `kill` reaches a background job that runs in this process. */
class JobControl {
  /** The signal `kill` sent, acted on between the job's commands. */
  signal: string | null = null;
  /** Wakes the job's sleeping or waiting built-in commands. */
  readonly abort = new AbortController();
  /** Children the job is waiting for: `kill` passes the signal on to them. */
  readonly children = new Set<number>();

  kill(signal: string): void {
    this.signal = signal;
    this.abort.abort();
    for (const pid of this.children) {
      try {
        runtime().processes.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
  }
}

/** State shared by a shell and all its subshells (one process). */
export interface ProcessState {
  /** Children the shell is waiting for in the foreground. */
  foreground: Set<number>;
  /** Exit status promises of every child started. */
  exits: Map<number, Promise<number>>;
  /** A SIGINT/SIGTERM that arrived and has not been acted on. */
  pendingSignal: string | null;
  /** Aborted on SIGINT/SIGTERM so sleeping or fetching builtins stop. */
  abort: AbortController;
  jobs: Job[];
  nextJobId: number;
  interactive: boolean;
  history: string[];
}

/** A shell builtin: runs in the shell itself and may change its state. */
export type Builtin = (shell: Shell, args: string[], io: CommandIo) => number | Promise<number>;

/** How long commands may run without the event loop turning before the shell lets it turn. */
const STARVED_MS = 50;
/** When the event loop was last seen to turn (-1: not watching yet). */
let turnSeenAt = -1;
/** A timer is waiting to report the next turn. */
let turnTimerArmed = false;
let checksSinceClock = 0;

/**
 * True when the event loop has not turned for `STARVED_MS`: the shell has run
 * only commands that never wait. Cheap enough to call between every command:
 * at most one timer is outstanding, and only while the loop is turning anyway.
 */
function eventLoopStarved(): boolean {
  // Reading the clock between every command of a tight loop shows; every
  // 32nd command is often enough.
  if ((++checksSinceClock & 31) !== 0) {
    return false;
  }
  const now = performance.now();
  if (!turnTimerArmed) {
    turnSeenAt = now;
    turnTimerArmed = true;
    setTimeout(() => {
      turnTimerArmed = false;
    }, 0);
    return false;
  }
  return now - turnSeenAt > STARVED_MS;
}

let yieldChannel: MessageChannel | null = null;
const yieldWaiters: (() => void)[] = [];

/**
 * Lets queued tasks run, the kernel's signal message among them. A message
 * rather than a timer: a browser holds a chain of nested `setTimeout(0)`
 * calls to 4 ms each, which a long loop would feel.
 */
function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel === "undefined") {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!yieldChannel) {
    yieldChannel = new MessageChannel();
    yieldChannel.port1.onmessage = () => yieldWaiters.shift()?.();
    // Node: the port must not keep the process alive.
    (yieldChannel.port1 as { unref?: () => void }).unref?.();
  }
  const channel = yieldChannel;
  return new Promise((resolve) => {
    yieldWaiters.push(resolve);
    channel.port2.postMessage(null);
  });
}

/** Thrown when a redirection cannot be set up; the command fails with status 1. */
class RedirectError extends Error {}

type Prepared =
  | { kind: "status"; status: number }
  | {
      kind: "external";
      argv: string[];
      env: Record<string, string>;
      table: FdTable;
      opened: number[];
    }
  | { kind: "internal"; run: () => Promise<number>; opened: number[] };

/** One shell: the main one or a subshell (a copy that cannot change its parent). */
export class Shell {
  vars: Map<string, Variable>;
  functions: Map<string, FunctionDef>;
  aliases: Map<string, string>;
  positional: string[];
  arg0: string;
  cwd: string;
  options: ShellOptions;
  traps: Map<string, string>;
  /** Names given to `export` while unset: exported once they are assigned. */
  pendingExports = new Set<string>();
  /** `$?`. */
  status = 0;
  /** `$!`. */
  lastBackground: number | undefined;
  /** In a background job run in this process: how `kill` reaches it. */
  private job: JobControl | null = null;
  /** In a pipeline stage: the pipe it writes to; the stage ends once nobody reads it. */
  stageOutput: number | null = null;
  /** This shell runs a background job: its commands start in a group of their own. */
  background = false;
  /** The shell's own fds; `exec 3>file` changes it. */
  fds: FdTable;
  /** True for the main shell, whose `cd` moves the process's working directory. */
  readonly root: boolean;
  readonly process: ProcessState;
  /** Saved variables of each active function call, for `local`. */
  readonly localScopes: Map<string, Variable | undefined>[] = [];
  /** Nesting of `if`/`while` conditions and `&&`/`||` heads, where `set -e` does not apply. */
  errexitSuppressed = 0;
  loopDepth = 0;
  functionDepth = 0;
  sourceDepth = 0;
  /** Status of the last command substitution, for a command with no command word. */
  private lastSubstitutionStatus: number | null = null;
  private currentLine = 0;

  constructor(options: {
    arg0: string;
    positional: string[];
    env: Record<string, string>;
    cwd: string;
    process: ProcessState;
    root?: boolean;
  }) {
    this.arg0 = options.arg0;
    this.positional = options.positional;
    this.cwd = options.cwd;
    this.process = options.process;
    this.root = options.root ?? true;
    this.vars = new Map();
    for (const [name, value] of Object.entries(options.env)) {
      this.vars.set(name, { value, exported: true, readonly: false });
    }
    this.functions = new Map();
    this.aliases = new Map();
    this.traps = new Map();
    this.fds = baseFdTable();
    this.options = {
      errexit: false,
      xtrace: false,
      nounset: false,
      pipefail: false,
      noglob: false,
      noclobber: false,
      allexport: false,
      verbose: false,
    };
  }

  /** A subshell: a deep copy whose changes stay inside it. */
  subshell(): Shell {
    const sub = new Shell({
      arg0: this.arg0,
      positional: [...this.positional],
      env: {},
      cwd: this.cwd,
      process: this.process,
      root: false,
    });
    for (const [name, variable] of this.vars) {
      sub.vars.set(name, { ...variable });
    }
    sub.background = this.background;
    sub.stageOutput = this.stageOutput;
    sub.job = this.job;
    sub.functions = new Map(this.functions);
    sub.aliases = new Map(this.aliases);
    sub.traps = new Map();
    sub.pendingExports = new Set(this.pendingExports);
    sub.options = { ...this.options };
    sub.status = this.status;
    sub.lastBackground = this.lastBackground;
    sub.fds = new Map(this.fds);
    sub.errexitSuppressed = this.errexitSuppressed;
    sub.loopDepth = 0;
    sub.functionDepth = 0;
    return sub;
  }

  get interactive(): boolean {
    return this.process.interactive;
  }

  // ---- variables ----

  /** A variable or special parameter's value; undefined when unset. */
  get(name: string): string | undefined {
    switch (name) {
      case "?":
        return String(this.status);
      case "$":
        return String(runtime().pid);
      case "!":
        return this.lastBackground === undefined ? undefined : String(this.lastBackground);
      case "#":
        return String(this.positional.length);
      case "0":
        return this.arg0;
      case "-":
        return this.flagString();
      case "@":
      case "*":
        return this.positional.join(" ");
      case "RANDOM":
        return String(Math.floor(Math.random() * 32768));
      case "LINENO":
        return String(this.currentLine);
      case "PPID":
        return String(runtime().ppid);
      case "SECONDS":
        return String(Math.floor(performance.now() / 1000));
    }
    if (/^\d+$/.test(name)) {
      return this.positional[Number(name) - 1];
    }
    return this.vars.get(name)?.value;
  }

  private flagString(): string {
    let flags = "";
    if (this.options.errexit) {
      flags += "e";
    }
    if (this.options.noglob) {
      flags += "f";
    }
    if (this.interactive) {
      flags += "i";
    }
    if (this.options.nounset) {
      flags += "u";
    }
    if (this.options.xtrace) {
      flags += "x";
    }
    return flags;
  }

  /** Sets a shell variable. Throws `ExpansionError` for a readonly one. */
  set(name: string, value: string, exported?: boolean): void {
    const existing = this.vars.get(name);
    if (existing?.readonly) {
      throw new ExpansionError(`${name}: readonly variable`, false);
    }
    if (existing) {
      existing.value = value;
      if (exported !== undefined) {
        existing.exported = exported;
      }
      if (this.options.allexport) {
        existing.exported = true;
      }
    } else {
      const pending = this.pendingExports.delete(name);
      this.vars.set(name, {
        value,
        exported: exported ?? (this.options.allexport || pending),
        readonly: false,
      });
    }
  }

  /** Removes a variable. Returns false for a readonly one. */
  unset(name: string): boolean {
    if (this.vars.get(name)?.readonly) {
      return false;
    }
    this.vars.delete(name);
    this.pendingExports.delete(name);
    return true;
  }

  /** The exported variables, as a child's environment. */
  environment(extra?: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, variable] of this.vars) {
      if (variable.exported) {
        env[name] = variable.value;
      }
    }
    return extra ? { ...env, ...extra } : env;
  }

  /** Resolves `path` against the shell's working directory. */
  resolve(path: string): string {
    return resolvePath(this.cwd, path);
  }

  /** Changes the working directory (the process's too, in the main shell). */
  chdir(path: string): void {
    const old = this.cwd;
    this.cwd = path;
    if (this.root) {
      runtime().cwd = path;
    }
    this.set("OLDPWD", old);
    this.set("PWD", path);
  }

  /**
   * The context word expansion runs in. `fds` are the fds in effect where the
   * word is expanded: a command substitution inherits them.
   */
  expandContext(fds: FdTable = this.fds): ExpandContext {
    return {
      get: (name) => this.get(name),
      set: (name, value) => this.set(name, value),
      positional: () => this.positional,
      substitute: (program) => this.substitute(program, fds),
      nounset: this.options.nounset,
      noglob: this.options.noglob,
      cwd: this.cwd,
      readdir: (path) => {
        try {
          return runtime()
            .fs.readdir(path)
            .map((entry) => {
              let isDir = entry.type === "dir";
              if (entry.type === "symlink") {
                try {
                  isDir =
                    (runtime().fs.stat(`${path.replace(/\/$/, "")}/${entry.name}`, true).mode &
                      0o170000) ===
                    0o040000;
                } catch {
                  isDir = false;
                }
              }
              return { name: entry.name, isDir };
            });
        } catch {
          return null;
        }
      },
    };
  }

  /** Prints `sh: message` to the shell's standard error. */
  error(message: string, fds: FdTable = this.fds): void {
    const fd = fds.get(2);
    if (fd !== null && fd !== undefined) {
      writeFd(fd, `sh: ${message}\n`);
    }
  }

  // ---- running ----

  /** Parses and runs source text; syntax errors print and return 2. */
  async runSource(source: string, fds: FdTable = this.fds): Promise<number> {
    let program: Program;
    try {
      program = parse(source);
    } catch (error) {
      if (error instanceof ShellSyntaxError) {
        this.error(error.message.replace(/^sh: /, ""), fds);
        this.status = 2;
        if (!this.interactive && this.sourceDepth === 0 && this.functionDepth === 0) {
          throw new ExitSignal(2);
        }
        return 2;
      }
      throw error;
    }
    return this.runList(program, fds);
  }

  /** Runs a list. */
  async runList(list: List, fds: FdTable): Promise<number> {
    let status = this.status;
    for (const item of list.items) {
      if (item.background) {
        await this.startBackground(item.andOr, fds);
        status = 0;
        this.status = 0;
      } else {
        status = await this.runAndOr(item.andOr, fds);
      }
      await this.checkSignals();
    }
    return status;
  }

  /**
   * Called between commands. Ends a pipeline stage whose reader has gone, and
   * acts on a SIGINT/SIGTERM that arrived: runs its trap, ends a
   * non-interactive shell, or abandons the command line of an interactive one.
   */
  async checkSignals(): Promise<void> {
    if (this.stageOutput !== null && isBrokenPipe(this.stageOutput)) {
      // As SIGPIPE ends a subshell stage in bash: `while :; do echo y; done | head -n 1`.
      throw new ExitSignal(141);
    }
    if (this.job?.signal) {
      throw new ExitSignal(128 + (signalNumber(this.job.signal) ?? 15));
    }
    if (this.process.pendingSignal === null) {
      if (!eventLoopStarved()) {
        return;
      }
      // Commands that never wait (`while :; do :; done`) would keep the worker
      // from ever handling the kernel's signal message: let queued tasks run.
      await yieldToEventLoop();
    }
    const signal = this.process.pendingSignal;
    // A background job ignores the terminal's signals, as in bash.
    if (signal === null || this.background) {
      return;
    }
    const short = signal.replace(/^SIG/, "");
    const trap = this.traps.get(short);
    if (trap !== undefined) {
      this.process.pendingSignal = null;
      if (trap !== "") {
        await this.runSource(trap);
      }
      return;
    }
    // Left pending so that the other stages of a pipeline, and the shells
    // around this subshell, stop too.
    if (!this.interactive) {
      throw new ExitSignal(128 + (signalNumber(signal) ?? 2));
    }
    throw new InterruptSignal();
  }

  private async runAndOr(andOr: AndOr, fds: FdTable): Promise<number> {
    const last = andOr.rest.length;
    let status = await this.runPipelineChecked(andOr.first, fds, last === 0);
    for (let i = 0; i < andOr.rest.length; i++) {
      const { op, pipeline } = andOr.rest[i];
      // Ctrl+C during `a` must not go on to run `b` of `a || b`.
      await this.checkSignals();
      if ((op === "&&" && status !== 0) || (op === "||" && status === 0)) {
        continue;
      }
      status = await this.runPipelineChecked(pipeline, fds, i === last - 1);
    }
    return status;
  }

  private async runPipelineChecked(
    pipeline: Pipeline,
    fds: FdTable,
    lastInChain: boolean,
  ): Promise<number> {
    const suppress = !lastInChain || pipeline.negated;
    if (suppress) {
      this.errexitSuppressed++;
    }
    let status: number;
    try {
      status = await this.runPipeline(pipeline, fds);
    } finally {
      if (suppress) {
        this.errexitSuppressed--;
      }
    }
    if (status !== 0 && !suppress && this.options.errexit && this.errexitSuppressed === 0) {
      throw new ExitSignal(status);
    }
    return status;
  }

  private async runPipeline(pipeline: Pipeline, fds: FdTable): Promise<number> {
    let status: number;
    if (pipeline.commands.length === 1) {
      status = await this.runCommand(pipeline.commands[0], fds);
    } else {
      status = await this.runMultiPipeline(pipeline, fds);
    }
    if (pipeline.negated) {
      status = status === 0 ? 1 : 0;
    }
    this.status = status;
    return status;
  }

  private async runMultiPipeline(pipeline: Pipeline, fds: FdTable): Promise<number> {
    const { commands } = pipeline;
    const n = commands.length;
    const rt = runtime();
    const pipes: { readFd: number; writeFd: number }[] = [];
    for (let i = 0; i < n - 1; i++) {
      pipes.push(rt.processes.pipe());
    }
    const stages: Prepared[] = [];
    for (let i = 0; i < n; i++) {
      const table = new Map(fds);
      if (i > 0) {
        table.set(0, pipes[i - 1].readFd);
      }
      if (i < n - 1) {
        table.set(1, pipes[i].writeFd);
        if (pipeline.stderrToo[i]) {
          table.set(2, pipes[i].writeFd);
        }
      }
      const sub = this.subshell();
      if (i < n - 1) {
        sub.stageOutput = pipes[i].writeFd;
      }
      const command = commands[i];
      // Every stage runs as a subshell would: `exit` (in a builtin or a
      // function too) ends only that stage.
      if (command.type === "simple") {
        const prepared = await sub.prepareSimpleSafely(command, table);
        stages.push(
          prepared.kind === "internal"
            ? { ...prepared, run: () => sub.runAsSubshell(prepared.run, table) }
            : prepared,
        );
      } else {
        stages.push({
          kind: "internal",
          opened: [],
          run: () => sub.runAsSubshell(() => sub.runCommand(command, table), table),
        });
      }
    }
    const statuses: number[] = Array.from({ length: n }, () => 0);
    const pids: (number | null)[] = Array.from({ length: n }, (): number | null => null);
    for (let i = 0; i < n; i++) {
      const stage = stages[i];
      if (stage.kind === "external") {
        const started = this.spawnExternal(stage.argv, stage.env, stage.table);
        this.closeAfterExit(started, stage.opened);
        if ("pid" in started) {
          pids[i] = started.pid;
        } else {
          statuses[i] = started.status;
        }
      } else if (stage.kind === "status") {
        statuses[i] = stage.status;
      }
    }
    const internal = (i: number): boolean => stages[i].kind === "internal";
    for (let i = 0; i < n - 1; i++) {
      if (!internal(i)) {
        closeFd(pipes[i].writeFd);
      }
      if (!internal(i + 1)) {
        closeFd(pipes[i].readFd);
      }
    }
    // The stages in this process run at the same time, as processes would:
    // a consumer sees output as it is written, and a stage that ends closes
    // its pipe ends (end of input for the next one, EPIPE for the one before).
    const running: Promise<void>[] = [];
    for (let i = 0; i < n; i++) {
      const stage = stages[i];
      if (stage.kind !== "internal") {
        continue;
      }
      running.push(
        (async () => {
          try {
            statuses[i] = await stage.run();
          } finally {
            stage.opened.forEach(closeFd);
            if (i < n - 1) {
              closeFd(pipes[i].writeFd);
            }
            if (i > 0) {
              closeFd(pipes[i - 1].readFd);
            }
          }
        })(),
      );
    }
    for (const outcome of await Promise.allSettled(running)) {
      if (outcome.status === "rejected") {
        throw outcome.reason;
      }
    }
    for (let i = 0; i < n; i++) {
      const pid = pids[i];
      if (pid !== null) {
        statuses[i] = await this.waitForeground(pid);
      }
    }
    if (this.options.pipefail) {
      for (let i = n - 1; i >= 0; i--) {
        if (statuses[i] !== 0) {
          return statuses[i];
        }
      }
      return 0;
    }
    return statuses[n - 1];
  }

  /** Runs one command (simple or compound) in this shell. */
  async runCommand(command: AstCommand, fds: FdTable): Promise<number> {
    try {
      switch (command.type) {
        case "simple":
          return await this.runSimple(command, fds);
        case "function":
          this.functions.set(command.name, command);
          return 0;
        default:
          return await this.withRedirects(command.redirects, fds, (table) =>
            this.runCompound(command, table),
          );
      }
    } catch (error) {
      return this.handleCommandError(error, fds);
    }
  }

  private handleCommandError(error: unknown, fds: FdTable): number {
    if (error instanceof ExpansionError) {
      this.error(error.message, fds);
      this.status = 1;
      if (!this.interactive && error.fatal) {
        throw new ExitSignal(1);
      }
      return 1;
    }
    if (error instanceof RedirectError) {
      this.error(error.message, fds);
      this.status = 1;
      return 1;
    }
    if (error instanceof ShellSyntaxError) {
      this.error(error.message, fds);
      this.status = 2;
      return 2;
    }
    throw error;
  }

  private async withRedirects(
    redirects: Redirect[],
    fds: FdTable,
    body: (table: FdTable) => Promise<number>,
  ): Promise<number> {
    if (redirects.length === 0) {
      return body(fds);
    }
    const { table, opened } = await this.applyRedirects(redirects, fds);
    try {
      return await body(table);
    } finally {
      opened.forEach(closeFd);
    }
  }

  private async runCompound(
    command: Exclude<AstCommand, SimpleCommand | FunctionDef>,
    fds: FdTable,
  ): Promise<number> {
    switch (command.type) {
      case "group":
        return this.runList(command.body, fds);
      case "subshell": {
        const sub = this.subshell();
        return sub.runAsSubshell(() => sub.runList(command.body, fds), fds);
      }
      case "if": {
        for (const clause of command.clauses) {
          if ((await this.runCondition(clause.condition, fds)) === 0) {
            return this.runList(clause.body, fds);
          }
        }
        if (command.elseBody) {
          return this.runList(command.elseBody, fds);
        }
        this.status = 0;
        return 0;
      }
      case "while": {
        let status = 0;
        this.loopDepth++;
        try {
          for (;;) {
            const condition = await this.runCondition(command.condition, fds);
            if (command.until ? condition === 0 : condition !== 0) {
              break;
            }
            const outcome = await this.runLoopBody(command.body, fds);
            status = outcome.status;
            if (outcome.stop) {
              break;
            }
          }
        } finally {
          this.loopDepth--;
        }
        this.status = status;
        return status;
      }
      case "for": {
        const items = command.items
          ? await expandWords(command.items, this.expandContext(fds))
          : [...this.positional];
        let status = 0;
        this.loopDepth++;
        try {
          for (const item of items) {
            this.set(command.variable, item);
            const outcome = await this.runLoopBody(command.body, fds);
            status = outcome.status;
            if (outcome.stop) {
              break;
            }
          }
        } finally {
          this.loopDepth--;
        }
        this.status = status;
        return status;
      }
      case "arithfor": {
        const ctx = this.expandContext(fds);
        const evaluate = async (text: string): Promise<number> =>
          text.trim() === "" ? 1 : arithmetic(ctx, await this.expandArithText(text, fds));
        let status = 0;
        this.loopDepth++;
        try {
          await evaluate(command.init);
          while ((await evaluate(command.test)) !== 0) {
            const outcome = await this.runLoopBody(command.body, fds);
            status = outcome.status;
            if (outcome.stop) {
              break;
            }
            await evaluate(command.update);
          }
        } finally {
          this.loopDepth--;
        }
        this.status = status;
        return status;
      }
      case "case":
        return this.runCase(command, fds);
      case "cond": {
        const result = await this.evalCond(command.expr, fds);
        this.status = result === null ? 2 : result ? 0 : 1;
        return this.status;
      }
      case "arithcmd": {
        const text = await expandString(command.expr, this.expandContext(fds));
        const value = arithmetic(this.expandContext(fds), text);
        this.status = value !== 0 ? 0 : 1;
        return this.status;
      }
    }
  }

  private async expandArithText(text: string, fds: FdTable): Promise<string> {
    if (!/[$`]/.test(text)) {
      return text;
    }
    const program = parse(`: $((${text}))`);
    const word = (program.items[0].andOr.first.commands[0] as SimpleCommand).words[1];
    const part = word.parts[0];
    return part.type === "arith"
      ? expandString({ parts: part.parts }, this.expandContext(fds))
      : text;
  }

  private async runCondition(list: List, fds: FdTable): Promise<number> {
    this.errexitSuppressed++;
    try {
      return await this.runList(list, fds);
    } finally {
      this.errexitSuppressed--;
    }
  }

  private async runLoopBody(body: List, fds: FdTable): Promise<{ status: number; stop: boolean }> {
    try {
      return { status: await this.runList(body, fds), stop: false };
    } catch (error) {
      if (error instanceof LoopSignal) {
        if (error.levels > 1) {
          error.levels--;
          throw error;
        }
        return { status: 0, stop: error.kind === "break" };
      }
      throw error;
    }
  }

  private async runCase(command: Case, fds: FdTable): Promise<number> {
    const ctx = this.expandContext(fds);
    const subject = await expandString(command.subject, ctx);
    let status = 0;
    let fallthrough = false;
    for (const item of command.items) {
      let matched = fallthrough;
      if (!matched) {
        for (const pattern of item.patterns) {
          if (await matchWord(subject, pattern, ctx)) {
            matched = true;
            break;
          }
        }
      }
      if (!matched) {
        continue;
      }
      status = await this.runList(item.body, fds);
      if (item.terminator === ";;") {
        fallthrough = false;
        break;
      }
      fallthrough = item.terminator === ";&";
    }
    this.status = status;
    return status;
  }

  /** Evaluates `[[ … ]]`: true, false, or null for a usage error. */
  async evalCond(expr: CondExpr, fds: FdTable = this.fds): Promise<boolean | null> {
    const ctx = this.expandContext(fds);
    switch (expr.type) {
      case "and": {
        const left = await this.evalCond(expr.left, fds);
        return left ? this.evalCond(expr.right, fds) : left;
      }
      case "or": {
        const left = await this.evalCond(expr.left, fds);
        return left === false ? this.evalCond(expr.right, fds) : left;
      }
      case "not": {
        const inner = await this.evalCond(expr.expr, fds);
        return inner === null ? null : !inner;
      }
      case "word":
        return (await expandString(expr.word, ctx)) !== "";
      case "unary": {
        const arg = await expandString(expr.arg, ctx);
        const result = unaryTest(expr.op, arg, this.cwd, (name) => this.get(name));
        if (typeof result === "string") {
          this.error(`[[: ${result}`, fds);
          return null;
        }
        return result;
      }
      case "binary": {
        const left = await expandString(expr.left, ctx);
        if (expr.op === "==" || expr.op === "=" || expr.op === "!=") {
          const matched = await matchWord(left, expr.right, ctx);
          return expr.op === "!=" ? !matched : matched;
        }
        if (expr.op === "=~") {
          const segs = await expandPattern(expr.right, ctx);
          const source = segs
            .map((seg) => (seg.quoted ? seg.text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&") : seg.text))
            .join("");
          let regex: RegExp;
          try {
            regex = new RegExp(source);
          } catch {
            return null;
          }
          const match = regex.exec(left);
          this.set("BASH_REMATCH", match ? match[0] : "");
          return match !== null;
        }
        if (expr.op === "<" || expr.op === ">") {
          const right = await expandString(expr.right, ctx);
          return expr.op === "<" ? left < right : left > right;
        }
        const right = await expandString(expr.right, ctx);
        if (/^-(eq|ne|lt|le|gt|ge)$/.test(expr.op)) {
          const a = arithmetic(ctx, left || "0");
          const b = arithmetic(ctx, right || "0");
          return binaryTest(expr.op, String(a), String(b), this.cwd) === true;
        }
        const result = binaryTest(expr.op, left, right, this.cwd);
        if (typeof result === "string") {
          this.error(`[[: ${result}`, fds);
          return null;
        }
        return result;
      }
    }
  }

  // ---- simple commands ----

  private async runSimple(command: SimpleCommand, fds: FdTable): Promise<number> {
    const prepared = await this.prepareSimple(command, fds);
    return this.runPrepared(prepared);
  }

  private async runPrepared(prepared: Prepared): Promise<number> {
    let status: number;
    switch (prepared.kind) {
      case "status":
        status = prepared.status;
        break;
      case "internal":
        try {
          status = await prepared.run();
        } finally {
          prepared.opened.forEach(closeFd);
        }
        break;
      case "external": {
        const started = this.spawnExternal(prepared.argv, prepared.env, prepared.table);
        this.closeAfterExit(started, prepared.opened);
        status = "pid" in started ? await this.waitForeground(started.pid) : started.status;
        break;
      }
    }
    this.status = status;
    return status;
  }

  private async prepareSimpleSafely(command: SimpleCommand, fds: FdTable): Promise<Prepared> {
    try {
      return await this.prepareSimple(command, fds);
    } catch (error) {
      if (error instanceof ExitSignal) {
        return { kind: "status", status: error.status };
      }
      try {
        return { kind: "status", status: this.handleCommandError(error, fds) };
      } catch (fatal) {
        // A fatal expansion error ends this subshell (a stage or a job), not its parent.
        if (fatal instanceof ExitSignal) {
          return { kind: "status", status: fatal.status };
        }
        throw fatal;
      }
    }
  }

  private expandAlias(command: SimpleCommand): SimpleCommand {
    const seen = new Set<string>();
    let current = command;
    for (;;) {
      const first = current.words[0];
      const name = first ? literalText(first) : null;
      if (!name || seen.has(name) || !this.aliases.has(name)) {
        return current;
      }
      seen.add(name);
      const program = parse(this.aliases.get(name) as string);
      const only = program.items.length === 1 ? program.items[0] : null;
      const inner =
        only && !only.background && only.andOr.rest.length === 0 ? only.andOr.first : null;
      const simple =
        inner && inner.commands.length === 1 && !inner.negated ? inner.commands[0] : null;
      if (!simple || simple.type !== "simple") {
        throw new ExpansionError(`${name}: only aliases for a simple command are supported`, false);
      }
      current = {
        ...current,
        assignments: [...current.assignments, ...simple.assignments],
        words: [...simple.words, ...current.words.slice(1)],
        redirects: [...simple.redirects, ...current.redirects],
      };
    }
  }

  private async prepareSimple(original: SimpleCommand, fds: FdTable): Promise<Prepared> {
    this.currentLine = original.line;
    const command = this.aliases.size > 0 ? this.expandAlias(original) : original;
    const ctx = this.expandContext(fds);
    this.lastSubstitutionStatus = null;
    const argv = await expandWords(command.words, ctx);
    if (argv.length === 0) {
      for (const assignment of command.assignments) {
        const value = await this.assignmentValue(assignment, ctx);
        if (this.vars.get(assignment.name)?.readonly) {
          // An assignment statement to a readonly variable ends a
          // non-interactive shell, as in bash (unlike `export`/`read`).
          throw new ExpansionError(`${assignment.name}: readonly variable`);
        }
        this.set(assignment.name, value);
      }
      if (command.redirects.length > 0) {
        const { opened } = await this.applyRedirects(command.redirects, fds);
        opened.forEach(closeFd);
      }
      if (this.options.xtrace && command.assignments.length > 0) {
        this.trace(
          command.assignments.map((a) => `${a.name}=${shellQuote(this.get(a.name) ?? "")}`),
          fds,
        );
      }
      return { kind: "status", status: this.lastSubstitutionStatus ?? 0 };
    }
    const prefix: Record<string, string> = {};
    for (const assignment of command.assignments) {
      prefix[assignment.name] = await this.assignmentValue(assignment, ctx);
    }
    if (argv[0] === "exec" && argv.length === 1) {
      // `exec 3>file`: the redirections apply to the shell itself.
      const { table } = await this.applyRedirects(command.redirects, this.fds);
      for (const target of fds === this.fds ? [this.fds] : [this.fds, fds]) {
        target.clear();
        for (const [fd, real] of table) {
          target.set(fd, real);
        }
      }
      return { kind: "status", status: 0 };
    }
    const { table, opened } = await this.applyRedirects(command.redirects, fds);
    if (this.options.xtrace) {
      this.trace(
        [
          ...Object.entries(prefix).map(([k, v]) => `${k}=${shellQuote(v)}`),
          ...argv.map(shellQuote),
        ],
        table,
      );
    }
    const prepared = this.prepareArgv(argv, prefix, table, false);
    if (prepared.kind === "status") {
      opened.forEach(closeFd);
      return prepared;
    }
    prepared.opened.push(...opened);
    return prepared;
  }

  private async assignmentValue(assignment: Assignment, ctx: ExpandContext): Promise<string> {
    const value = await expandString(assignment.value, ctx);
    return assignment.append ? (this.get(assignment.name) ?? "") + value : value;
  }

  private trace(words: string[], fds: FdTable): void {
    const fd = fds.get(2);
    if (fd !== null && fd !== undefined) {
      const ps4 = this.get("PS4") ?? "+ ";
      writeFd(fd, `${ps4}${words.join(" ")}\n`);
    }
  }

  /**
   * Decides how to run `argv`: a function, a builtin, a built-in command or an
   * external program. Prefix assignments are visible to it only.
   */
  prepareArgv(
    argv: string[],
    prefix: Record<string, string>,
    table: FdTable,
    skipFunctions: boolean,
  ): Prepared {
    const name = argv[0];
    const args = argv.slice(1);
    const fn = skipFunctions ? undefined : this.functions.get(name);
    if (fn) {
      return {
        kind: "internal",
        opened: [],
        run: () => this.withTemporaryVars(prefix, () => this.callFunction(fn, args, table)),
      };
    }
    const builtin = BUILTINS[name];
    if (builtin) {
      return {
        kind: "internal",
        opened: [],
        run: () =>
          this.withTemporaryVars(prefix, async () => builtin(this, args, new CommandIo(table))),
      };
    }
    const command = COMMANDS[name];
    if (command) {
      return {
        kind: "internal",
        opened: [],
        run: async () => {
          const io = new CommandIo(table);
          const ctx = this.commandContext(name, io, this.environment(prefix));
          try {
            return await command(ctx, args);
          } catch (error) {
            io.err(`${name}: ${error instanceof Error ? error.message : String(error)}\n`);
            return 1;
          }
        },
      };
    }
    return { kind: "external", argv, env: this.environment(prefix), table, opened: [] };
  }

  /** The context a built-in command runs with. */
  commandContext(name: string, io: CommandIo, env: Record<string, string>): CommandContext {
    return {
      name,
      cwd: this.cwd,
      env,
      io,
      signal: this.job
        ? AbortSignal.any([this.process.abort.signal, this.job.abort.signal])
        : this.process.abort.signal,
      resolve: (path) => this.resolve(path),
      exec: (argv, extraEnv, replaceEnv) => {
        if (!replaceEnv) {
          return this.runPrepared(this.prepareArgv(argv, extraEnv ?? {}, io.fds, false));
        }
        const sub = this.subshell();
        sub.vars = new Map(
          Object.entries(extraEnv ?? {}).map(([key, value]) => [
            key,
            { value, exported: true, readonly: false },
          ]),
        );
        return sub.runPrepared(sub.prepareArgv(argv, {}, io.fds, false)).catch((error: unknown) => {
          if (error instanceof ExitSignal) {
            return error.status;
          }
          throw error;
        });
      },
    };
  }

  /** Runs `argv` with the given fds and waits for it (for `command`, `xargs`, `find -exec`). */
  async execArgv(
    argv: string[],
    table: FdTable,
    skipFunctions = false,
    prefix: Record<string, string> = {},
  ): Promise<number> {
    return this.runPrepared(this.prepareArgv(argv, prefix, table, skipFunctions));
  }

  private async withTemporaryVars<T>(
    vars: Record<string, string>,
    body: () => Promise<T>,
  ): Promise<T> {
    const names = Object.keys(vars);
    if (names.length === 0) {
      return body();
    }
    const saved = new Map<string, Variable | undefined>();
    const pending = names.filter((name) => this.pendingExports.has(name));
    for (const name of names) {
      const existing = this.vars.get(name);
      saved.set(name, existing ? { ...existing } : undefined);
      this.set(name, vars[name], true);
    }
    try {
      return await body();
    } finally {
      for (const [name, variable] of saved) {
        if (variable) {
          this.vars.set(name, variable);
        } else {
          this.vars.delete(name);
        }
      }
      for (const name of pending) {
        this.pendingExports.add(name);
      }
    }
  }

  /** Calls a shell function with `args` as its positional parameters. */
  async callFunction(fn: FunctionDef, args: string[], fds: FdTable): Promise<number> {
    if (this.functionDepth > 200) {
      throw new ExpansionError(`${fn.name}: maximum function nesting level exceeded`);
    }
    const savedPositional = this.positional;
    this.positional = args;
    this.functionDepth++;
    const scope = new Map<string, Variable | undefined>();
    this.localScopes.push(scope);
    try {
      return await this.runCommand(fn.body, fds);
    } catch (error) {
      if (error instanceof ReturnSignal) {
        this.status = error.status;
        return error.status;
      }
      throw error;
    } finally {
      this.localScopes.pop();
      for (const [name, variable] of scope) {
        if (variable) {
          this.vars.set(name, variable);
        } else {
          this.vars.delete(name);
        }
      }
      this.functionDepth--;
      this.positional = savedPositional;
    }
  }

  /** `local name[=value]`: saves the variable for restoration when the function returns. */
  makeLocal(name: string): boolean {
    const scope = this.localScopes[this.localScopes.length - 1];
    if (!scope) {
      return false;
    }
    if (!scope.has(name)) {
      const existing = this.vars.get(name);
      scope.set(name, existing ? { ...existing } : undefined);
    }
    return true;
  }

  // ---- redirections ----

  /** Applies redirections to a copy of `fds`; returns the new table and the fds it opened. */
  async applyRedirects(
    redirects: Redirect[],
    fds: FdTable,
  ): Promise<{ table: FdTable; opened: number[] }> {
    const table = new Map(fds);
    const opened: number[] = [];
    const rt = runtime();
    try {
      for (const redirect of redirects) {
        await this.applyRedirect(redirect, table, opened, rt);
      }
    } catch (error) {
      opened.forEach(closeFd);
      throw error;
    }
    return { table, opened };
  }

  private async applyRedirect(
    redirect: Redirect,
    table: FdTable,
    opened: number[],
    rt: ReturnType<typeof runtime>,
  ): Promise<void> {
    const ctx = this.expandContext(table);
    const { op } = redirect;
    if (op === "<<" || op === "<<-" || op === "<<<") {
      let text: string;
      if (op === "<<<") {
        text = `${await expandString(redirect.target, ctx)}\n`;
      } else {
        text = await expandString(redirect.heredoc?.body ?? { parts: [] }, ctx);
      }
      const pipe = rt.processes.pipe();
      writeFd(pipe.writeFd, encode(text));
      closeFd(pipe.writeFd);
      opened.push(pipe.readFd);
      table.set(redirect.fd ?? 0, pipe.readFd);
      return;
    }
    const target = await this.redirectTarget(redirect.target, ctx);
    if (op === ">&" || op === "<&") {
      const fd = redirect.fd ?? (op === ">&" ? 1 : 0);
      if (target === "-") {
        table.set(fd, null);
        return;
      }
      if (/^\d+$/.test(target)) {
        const source = table.get(Number(target));
        if (source === undefined || source === null) {
          throw new RedirectError(`${target}: Bad file descriptor`);
        }
        table.set(fd, source);
        return;
      }
      if (op === ">&" && redirect.fd === undefined) {
        const real = this.openFile(target, O_WRONLY | O_CREAT | O_TRUNC, true);
        opened.push(real);
        table.set(1, real);
        table.set(2, real);
        return;
      }
      throw new RedirectError(`${target}: ambiguous redirect`);
    }
    let flags: number;
    let fds: number[];
    switch (op) {
      case "<":
        flags = O_RDONLY;
        fds = [redirect.fd ?? 0];
        break;
      case ">":
      case ">|":
        flags = O_WRONLY | O_CREAT | O_TRUNC;
        fds = [redirect.fd ?? 1];
        break;
      case ">>":
        flags = O_WRONLY | O_CREAT | O_APPEND;
        fds = [redirect.fd ?? 1];
        break;
      case "<>":
        flags = O_RDWR | O_CREAT;
        fds = [redirect.fd ?? 0];
        break;
      case "&>":
        flags = O_WRONLY | O_CREAT | O_TRUNC;
        fds = [1, 2];
        break;
      case "&>>":
        flags = O_WRONLY | O_CREAT | O_APPEND;
        fds = [1, 2];
        break;
    }
    const real = this.openFile(target, flags, op === ">");
    opened.push(real);
    if (op === "<" || op === "<>") {
      trackFileOffset(real);
    }
    for (const fd of fds) {
      table.set(fd, real);
    }
  }

  private async redirectTarget(word: Word, ctx: ExpandContext): Promise<string> {
    const fields = await expandWords([word], ctx);
    if (fields.length !== 1) {
      throw new RedirectError(`${await expandString(word, ctx)}: ambiguous redirect`);
    }
    return fields[0];
  }

  private openFile(target: string, flags: number, clobberCheck: boolean): number {
    const path = this.resolve(target);
    const fs = runtime().fs;
    if (clobberCheck && this.options.noclobber && path !== "/dev/null" && fs.exists(path)) {
      throw new RedirectError(`${target}: cannot overwrite existing file`);
    }
    try {
      return fs.open(path, flags, 0o666);
    } catch (error) {
      const record = toSystemErrorRecord(error);
      const text: Record<string, string> = {
        ENOENT: "No such file or directory",
        EISDIR: "Is a directory",
        EACCES: "Permission denied",
        ENOTDIR: "Not a directory",
      };
      throw new RedirectError(
        `${target}: ${(record && text[record.code]) ?? (error as Error).message}`,
      );
    }
  }

  // ---- processes ----

  /** Spawns an external command; reports a failure to start and returns its status. */
  spawnExternal(
    argv: string[],
    env: Record<string, string>,
    table: FdTable,
  ): { pid: number } | { status: number } {
    const rt = runtime();
    let max = 2;
    for (const fd of table.keys()) {
      max = Math.max(max, fd);
    }
    const stdio: (number | "ignore")[] = [];
    for (let fd = 0; fd <= max; fd++) {
      const real = table.get(fd);
      stdio.push(real === null || real === undefined ? "ignore" : real);
    }
    const name = argv[0];
    try {
      const child = rt.processes.spawn({
        command: name,
        args: argv.slice(1),
        cwd: this.cwd,
        env,
        stdio,
        newGroup: this.background,
      });
      this.trackExit(child.pid);
      return { pid: child.pid };
    } catch (error) {
      const record = toSystemErrorRecord(error);
      if (record?.code === "ENOENT") {
        this.error(
          name.includes("/") ? `${name}: No such file or directory` : `command not found: ${name}`,
          table,
        );
        return { status: 127 };
      }
      if (record && ["EACCES", "EISDIR", "ENOEXEC", "EPERM"].includes(record.code)) {
        this.error(
          `${name}: ${record.code === "EISDIR" ? "Is a directory" : "Permission denied"}`,
          table,
        );
        return { status: 126 };
      }
      this.error(`${name}: ${error instanceof Error ? error.message : String(error)}`, table);
      return { status: 126 };
    }
  }

  /**
   * Closes the fds a redirection opened for a child once it has exited (the
   * child holds its own copies; ours stay valid until then), or now when it
   * did not start.
   */
  private closeAfterExit(started: { pid: number } | { status: number }, opened: number[]): void {
    if (opened.length === 0) {
      return;
    }
    if ("pid" in started) {
      void this.trackExit(started.pid).then(() => opened.forEach(closeFd));
    } else {
      opened.forEach(closeFd);
    }
  }

  private trackExit(pid: number): Promise<number> {
    const existing = this.process.exits.get(pid);
    if (existing) {
      return existing;
    }
    const promise = new Promise<number>((resolve) => {
      runtime().processes.onExit(pid, (status) => resolve(statusOf(status)));
    });
    this.process.exits.set(pid, promise);
    return promise;
  }

  /** Waits for a child in the foreground (signals are forwarded to it). */
  async waitForeground(pid: number): Promise<number> {
    this.process.foreground.add(pid);
    this.job?.children.add(pid);
    try {
      return await this.trackExit(pid);
    } finally {
      this.job?.children.delete(pid);
      this.process.foreground.delete(pid);
      this.process.exits.delete(pid);
    }
  }

  /** Starts an and-or list in the background; resolves once it has been started. */
  private async startBackground(andOr: AndOr, fds: FdTable): Promise<void> {
    const subshell = () => {
      const sub = this.subshell();
      // A background job's commands do not take the terminal's Ctrl+C.
      sub.background = true;
      return sub;
    };
    // A job run in this process gets a pid of its own for `$!`, `kill` and `wait`.
    const inProcess = (sub: Shell, run: () => Promise<number>, table: FdTable): void => {
      const control = new JobControl();
      sub.job = control;
      job.pid = nextJobPid++;
      job.kill = (signal) => control.kill(signal);
      this.lastBackground = job.pid;
      job.done = sub
        .runAsSubshell(run, table)
        .catch((error: unknown) => (error instanceof ExitSignal ? error.status : 1));
    };
    const id = this.process.nextJobId++;
    const first = andOr.first.commands[0];
    const single =
      andOr.rest.length === 0 &&
      andOr.first.commands.length === 1 &&
      !andOr.first.negated &&
      first.type === "simple"
        ? first
        : null;
    const job: Job = {
      id,
      pid: null,
      command: `job ${id}`,
      done: Promise.resolve(0),
      status: null,
    };
    if (single) {
      const sub = subshell();
      const prepared = await sub.prepareSimpleSafely(single, fds);
      if (prepared.kind === "external") {
        const result = sub.spawnExternal(prepared.argv, prepared.env, prepared.table);
        this.closeAfterExit(result, prepared.opened);
        job.command = prepared.argv.join(" ");
        if ("pid" in result) {
          job.pid = result.pid;
          this.lastBackground = result.pid;
          job.done = this.trackExit(result.pid);
        } else {
          job.done = Promise.resolve(result.status);
        }
      } else {
        job.command = "(in-process)";
        inProcess(sub, () => sub.runPrepared(prepared), fds);
      }
    } else {
      const sub = subshell();
      inProcess(sub, () => sub.runList({ items: [{ andOr, background: false }] }, fds), fds);
    }
    job.done = job.done.then((status) => {
      job.status = status;
      return status;
    });
    this.process.jobs.push(job);
    if (this.interactive) {
      this.error(`[${id}] ${job.pid ?? ""}`.trimEnd());
    }
  }

  // ---- command substitution ----

  /**
   * Runs a program in a subshell with the fds in effect where it is expanded
   * (`fds`), and returns what it wrote to standard output.
   */
  async substitute(program: Program, fds: FdTable = this.fds): Promise<string> {
    const rt = runtime();
    const pipe = rt.processes.pipe();
    const table = new Map(fds);
    table.set(1, pipe.writeFd);
    const sub = this.subshell();
    let status = 0;
    try {
      status = await sub.runAsSubshell(() => sub.runList(program, table), table);
    } catch (error) {
      closeFd(pipe.writeFd);
      closeFd(pipe.readFd);
      throw error;
    }
    closeFd(pipe.writeFd);
    const bytes = await readAllAsync(pipe.readFd);
    closeFd(pipe.readFd);
    this.lastSubstitutionStatus = status;
    this.status = status;
    return decode(bytes);
  }

  /**
   * Runs `body` as the whole life of this subshell: `exit` ends only the
   * subshell, and an EXIT trap it set runs when it ends.
   */
  async runAsSubshell(body: () => Promise<number>, fds: FdTable): Promise<number> {
    let status: number;
    try {
      status = await body();
    } catch (error) {
      if (!(error instanceof ExitSignal)) {
        throw error;
      }
      status = error.status;
    }
    if (this.traps.has("EXIT")) {
      this.status = status;
      await this.runExitTrap(fds);
    }
    return status;
  }

  /** Runs the EXIT trap, once, with `fds` (those of the subshell that ends). */
  async runExitTrap(fds: FdTable = this.fds): Promise<void> {
    const trap = this.traps.get("EXIT");
    if (trap === undefined) {
      return;
    }
    this.traps.delete("EXIT");
    try {
      await this.runSource(trap, fds);
    } catch (error) {
      if (!(error instanceof ExitSignal)) {
        throw error;
      }
    }
  }
}
