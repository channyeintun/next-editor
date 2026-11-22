// The shell interpreter: variables, functions, options and traps; runs the
// syntax tree — lists, and-or chains, pipelines, compound commands,
// redirections — and dispatches each simple command to a function, a shell
// builtin, a built-in command (commands/) or an external process spawned
// through the kernel.
import { toSystemErrorRecord } from "../../../errors";
import { O_APPEND, O_CREAT, O_RDONLY, O_RDWR, O_TRUNC, O_WRONLY } from "../../../kernel/vfs/types";
import { endsByDefault, exitStatusNumber, signalExitStatus } from "../../../signals";
import { DEFAULT_PATH } from "../../platform";
import { runtime } from "../../runtime";
import type { ExitStatus, FsBackend, SpawnRequest } from "../../runtime";
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
import { backgroundReadsNull } from "./backgroundInput";
import { BUILTINS } from "./builtins";
import { COMMANDS, SHELL_BUILTIN_COMMANDS } from "./commands/index";
import { binaryTest, unaryTest } from "./commands/test";
import { absolutePath, errnoText, isDir, isFile, tryStat } from "./commands/util";
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
  ReadInterrupted,
  baseFdTable,
  closeFd,
  decode,
  descriptorOf,
  encode,
  giveBackAllInput,
  giveBackInput,
  isBrokenPipe,
  openNull,
  openPipe,
  readAllAsync,
  trackFileOffset,
  writeFd,
} from "./io";
import type { FdTable } from "./io";
import { addJob, addOwnJob, announceEndedJobs, inheritJobs, newJobList, newJobTable } from "./jobs";
import type { Job, JobList, JobTable } from "./jobs";
import { ShellSyntaxError } from "./lexer";
import { literalText, parse } from "./parser";
import { isPlainWord } from "./plainWords";
import { shellQuote } from "./quote";
import {
  declareEverySignalHandled,
  declareHandledSignals,
  handledSignals,
  runsExitTrap,
} from "./signals";
import { filesystemUnder } from "./umask";

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
  /** The programs the job runs, each until it has ended: `kill` passes the signal on to them. */
  readonly children = new Set<number>();
  /** Each of those programs leads a process group of its own (a job of a shell with job control). */
  private readonly ownGroups: boolean;

  constructor(ownGroups: boolean) {
    this.ownGroups = ownGroups;
  }

  /**
   * `wholeJob`: the signal is for the job (`kill %N`), which under job
   * control is every process of its groups, what its programs started
   * included; otherwise for the job's own pid, and the programs it waits for.
   */
  kill(signal: string, wholeJob: boolean): void {
    // As for a process: these do not end it (and it cannot be stopped).
    if (!endsByDefault(signal)) {
      return;
    }
    this.signal = signal;
    this.abort.abort();
    for (const pid of this.children) {
      try {
        runtime().processes.kill(wholeJob && this.ownGroups ? -pid : pid, signal);
      } catch {
        // Already gone.
      }
    }
  }
}

/** State shared by a shell and all its subshells (one process). */
export interface ProcessState extends JobTable {
  /**
   * The programs the shell runs in the foreground, each until it has ended:
   * a signal sent to the shell alone is passed on to them.
   */
  foreground: Set<number>;
  /** How each child started ends. */
  exits: Map<number, Promise<ExitStatus>>;
  /** A signal that arrived and has not been acted on (`Shell.checkSignals`). */
  pendingSignal: string | null;
  /**
   * The pending signal is the main shell's alone: a trapped one that did
   * not come from the terminal, which stops none of its commands and none
   * of its subshells (`pendSignal`).
   */
  pendingForMain: boolean;
  /**
   * Aborted by a signal the shell acts on, so that sleeping, reading and
   * waiting builtins stop; it stays aborted while that signal is pending, so
   * that nothing started meanwhile waits either (`settleSignal`).
   */
  abort: AbortController;
  /**
   * Aborted by every signal the shell acts on, a trapped one too: what
   * wakes the `wait` builtin, which bash interrupts for a trap. It stays
   * aborted while the signal is pending, as `abort` does.
   */
  wake: AbortController;
  /**
   * The signal that ends this shell now, without a trap to run first (a
   * SIGTERM or SIGHUP to a script), or null. Its waits for foreground
   * programs end with it (`ending` is aborted): bash dies of such a signal
   * without waiting for the programs it runs.
   */
  fatalSignal: string | null;
  ending: AbortController;
  /**
   * By signal: how many the shell sent its own process group, itself
   * included, and acted on as it sent them (`raiseSignal`). The kernel's
   * copy of each, for the shell, is still to arrive, and is dropped.
   */
  ownSignals: Map<string, number>;
  /**
   * The program the shell runs as if it had exec'd it (`exec`, the lone
   * command of `sh -c`), while it runs: bash is that program by then, so a
   * signal for the shell is the program's, and the shell ends as it ends.
   */
  standIn: number | null;
  interactive: boolean;
  history: string[];
  /**
   * How many foreground lines of work run at once: the shell itself, or the
   * in-process stages of a pipeline, plus a command substitution and a
   * built-in program (xargs, find …) while they run. Compared with `waiting`
   * to tell a shell that only waits for its commands (`deferInterrupt`).
   */
  flows: number;
  /** The foreground waits for an external command in progress. */
  waiting: Set<ForegroundWait>;
  /** A foreground external command started since the shell last took the terminal back. */
  jobRan: boolean;
  /**
   * A program ran in the foreground (an external one, or a built-in one
   * that is not a bash builtin) since the shell last gave the notices of
   * its ended background jobs (`Shell.announceAfterJob`).
   */
  programRan: boolean;
  /** Foreground pipelines of several commands in progress: jobs whose stages may still run. */
  pipelines: number;
  /** How many SIGINTs the shell has acted on (`interruptShell`). */
  interrupts: number;
}

/** One wait for a foreground external command (`Shell.waitForeground`). */
interface ForegroundWait {
  /** A SIGINT reached the shell during the wait and was left to the command. */
  interrupted: boolean;
}

/** The state of a new shell process. */
export function newProcessState(interactive: boolean): ProcessState {
  return {
    foreground: new Set(),
    exits: new Map(),
    pendingSignal: null,
    pendingForMain: false,
    abort: new AbortController(),
    wake: new AbortController(),
    fatalSignal: null,
    ending: new AbortController(),
    ownSignals: new Map(),
    standIn: null,
    ...newJobTable(),
    interactive,
    history: [],
    flows: 1,
    waiting: new Set(),
    jobRan: false,
    programRan: false,
    pipelines: 0,
    interrupts: 0,
  };
}

/**
 * Acts on `signal`: the shell's own commands stop (sleeping, reading and
 * waiting builtins wake), and it is pending until `checkSignals` runs its
 * trap, ends the shell or abandons the command line.
 */
export function interruptShell(process: ProcessState, signal: string): void {
  if (signal === "SIGINT") {
    process.interrupts += 1;
  }
  process.abort.abort();
  process.wake.abort();
  process.pendingSignal = signal;
  process.pendingForMain = false;
}

/**
 * `signal` is pending, for its trap to run once the command in progress has
 * ended: only `wait` wakes for it (`ProcessState.wake`).
 */
function pendSignal(process: ProcessState, signal: string): void {
  process.wake.abort();
  if (process.pendingSignal === null) {
    process.pendingSignal = signal;
    process.pendingForMain = true;
  }
}

/**
 * The pending signal has been acted on, or was not the shell's to act on:
 * the commands that run from now on are not stopped by it.
 */
export function settleSignal(process: ProcessState): void {
  process.pendingSignal = null;
  process.pendingForMain = false;
  process.fatalSignal = null;
  if (process.abort.signal.aborted) {
    process.abort = new AbortController();
  }
  if (process.wake.signal.aborted) {
    process.wake = new AbortController();
  }
  if (process.ending.signal.aborted) {
    process.ending = new AbortController();
  }
}

/**
 * A signal has reached the shell's process: what `main`, its main shell,
 * does about it. `fromTerminal`: it is the terminal's (a Ctrl+C), which
 * reached the shell's foreground programs as well. Returns false for a
 * signal the shell leaves to its default action, which ends it at once.
 */
export function receiveSignal(main: Shell, signal: string, fromTerminal: boolean): boolean {
  const process = main.process;
  const own = process.ownSignals.get(signal) ?? 0;
  if (own > 0) {
    // The shell sent it, and has acted on it.
    if (own === 1) {
      process.ownSignals.delete(signal);
    } else {
      process.ownSignals.set(signal, own - 1);
    }
    return true;
  }
  return actOnSignal(main, signal, fromTerminal);
}

/** `receiveSignal`, for a signal that is known not to be one the shell sent itself. */
function actOnSignal(main: Shell, signal: string, fromTerminal: boolean): boolean {
  const process = main.process;
  // bash runs a CHLD trap when a child ends, never for a CHLD sent to it.
  if (signal === "SIGCHLD") {
    return true;
  }
  if (process.handedOver !== null) {
    signalOwnJobs(main, signal, fromTerminal);
    return true;
  }
  const trap = main.traps.get(signal.replace(/^SIG/, ""));
  if (trap === "" || (trap === undefined && !endsByDefault(signal))) {
    return true;
  }
  if (process.standIn !== null) {
    // The signal is the program's the shell stands for: it has the
    // terminal's already, and gets any other from here. The shell does
    // nothing itself: it ends as the program ends.
    if (!fromTerminal) {
      passOn(process, signal);
    }
    return true;
  }
  if (signal === "SIGPIPE") {
    // The kernel's word of a write to a pipe nobody reads. The write failed
    // as well (EPIPE), which ends what made it (`Shell.runOwn`): only a trap
    // is left to run.
    if (trap !== undefined) {
      process.pendingSignal = signal;
    }
    return true;
  }
  if (trap !== undefined && !fromTerminal) {
    // As in bash, a trapped signal is the shell's alone: its programs, the
    // built-in ones too, run on to their own end, and the trap runs once
    // the command in progress has ended (`wait` returns at once for it).
    pendSignal(process, signal);
    return true;
  }
  const known =
    signal === "SIGINT" || signal === "SIGTERM" || signal === "SIGHUP" || signal === "SIGQUIT";
  if (!known && trap === undefined && !(main.traps.has("EXIT") && runsExitTrap(signal))) {
    // It ends the shell here and now: what the shell read and did not use
    // goes back first, for the next reader.
    giveBackAllInput();
    return false;
  }
  // A signal that ends the shell was sent to it alone: its foreground
  // programs get it from here, where bash would leave them running without
  // a shell. Not a SIGINT: the terminal's reached them with the shell, and
  // one sent to the shell alone is the shell's, as in bash, whose programs
  // run on to their own end.
  if (signal !== "SIGINT") {
    passOn(process, signal);
  }
  // While it only waits for its commands, a SIGINT is theirs to act on
  // first, as in bash: the shell goes on if they caught it.
  if (signal === "SIGINT" && trap === undefined && deferInterrupt(process)) {
    return true;
  }
  interruptShell(process, signal);
  if (trap !== undefined) {
    return true;
  }
  if (process.interactive) {
    if (signal === "SIGINT") {
      // A Ctrl+C while the shell runs commands of its own (a loop of
      // builtins, a stage of a pipeline) abandons the command line. One
      // that came while it waited for a foreground program is that
      // program's to act on.
      if (process.waiting.size > 0) {
        settleSignal(process);
      }
      return true;
    }
    if (signal === "SIGTERM" || signal === "SIGQUIT") {
      // An interactive shell ignores these, as bash does.
      settleSignal(process);
      return true;
    }
    // A hangup ends an interactive shell too, and so does any other signal
    // that it hears of because its EXIT trap is to run first. Its
    // background jobs are hung up with it, as bash resends them the SIGHUP.
    if (signal === "SIGHUP") {
      hangUpJobs(main.jobList);
    }
  }
  if (signal !== "SIGINT") {
    endForegroundWaits(process, signal);
  }
  return true;
}

/**
 * A signal for the process that runs the jobs an ended shell handed over
 * (`outliveShell`): each is a forked subshell in bash, and a signal that
 * ends a process ends them, with their programs (`JobControl.kill`). As
 * there, a job ignores what the shell ignored (`trap '' SIG`), and without
 * job control SIGINT and SIGQUIT, which bash ignores in an asynchronous
 * command; under job control the terminal's do not reach it either. A
 * broken pipe is the EPIPE of the write, which ends the command that made it.
 */
function signalOwnJobs(main: Shell, signal: string, fromTerminal: boolean): void {
  if (!endsByDefault(signal) || signal === "SIGPIPE" || main.traps.get(signal.slice(3)) === "") {
    return;
  }
  const interrupt = signal === "SIGINT" || signal === "SIGQUIT";
  if (interrupt && (!main.process.interactive || fromTerminal)) {
    return;
  }
  for (const job of main.process.ownJobs) {
    job.kill?.(signal, false);
  }
}

/** Sends SIGHUP to every background job still running: to its whole process group, where it has one. */
function hangUpJobs(list: JobList): void {
  for (const job of list.jobs) {
    if (job.status !== null || job.pid === null || job.keptFromHangup) {
      continue;
    }
    if (job.kill) {
      job.kill("SIGHUP", true);
      continue;
    }
    try {
      runtime().processes.kill(job.ownGroup ? -job.pid : job.pid, "SIGHUP");
    } catch {
      // Already gone.
    }
  }
}

/**
 * How the shell ends of the signal that ends it now (`fatalSignal`): what
 * its waits throw once `ending` is aborted.
 */
export function fatalExit(process: ProcessState): ExitSignal {
  const signal = process.fatalSignal ?? "SIGTERM";
  return new ExitSignal(signalExitStatus(signal), signal);
}

/** Sends `signal` to the programs the shell runs in the foreground. */
function passOn(process: ProcessState, signal: string): void {
  for (const pid of process.foreground) {
    try {
      runtime().processes.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * `signal` ends the shell now: its waits for foreground programs end (see
 * `ProcessState.fatalSignal`). A SIGINT is not such a signal: the programs
 * of a pipeline are waited for, as they decide what it does to the shell.
 */
function endForegroundWaits(process: ProcessState, signal: string): void {
  process.fatalSignal = signal;
  process.ending.abort();
}

/**
 * The shell sends `signal` to itself (`kill -TERM $$`), or with `viaKernel`
 * to its process group (`kill 0`): it is delivered before the `kill`
 * returns, as kill(2) delivers a signal to its caller, so its trap runs, or
 * the shell ends, before the next command. False for a signal the shell
 * does not handle itself: the kernel acts on that one, at once.
 */
function raiseSignal(main: Shell, signal: string, viaKernel: boolean): boolean {
  if (!handledSignals(main.traps.keys()).has(signal)) {
    return false;
  }
  const process = main.process;
  if (viaKernel) {
    process.ownSignals.set(signal, (process.ownSignals.get(signal) ?? 0) + 1);
  }
  if (signal === "SIGPIPE" && !main.traps.has("PIPE")) {
    // Not the kernel's word of a failed write: the signal itself, which
    // ends a shell that does not trap it.
    interruptShell(process, signal);
    endForegroundWaits(process, signal);
    return true;
  }
  if (!actOnSignal(main, signal, false)) {
    // Its default action, as the kernel's copy would have had.
    runtime().processes.die(signal);
  }
  return true;
}

/**
 * bash's wait-and-cooperative-exit: a non-interactive shell that a SIGINT
 * reaches while it does nothing but wait for its foreground commands leaves
 * it to them (they got the Ctrl+C too). Each wait then acts on it only if
 * its command died of it; a command that caught it and exited lets the shell
 * go on. False, act on it now, while a command of the shell's own runs, or
 * when the shell is interactive or waits for nothing.
 */
export function deferInterrupt(process: ProcessState): boolean {
  if (process.interactive || process.waiting.size === 0 || process.waiting.size < process.flows) {
    return false;
  }
  for (const wait of process.waiting) {
    wait.interrupted = true;
  }
  return true;
}

/** The command of source text that is one simple command, run in the foreground; else null. */
function loneSimpleCommand(source: string): SimpleCommand | null {
  let program: Program;
  try {
    program = parse(source);
  } catch {
    return null;
  }
  const only = program.items.length === 1 ? program.items[0] : null;
  if (!only || only.background || only.andOr.rest.length > 0) {
    return null;
  }
  const pipeline = only.andOr.first;
  const command = pipeline.commands.length === 1 ? pipeline.commands[0] : null;
  return !pipeline.negated && command?.type === "simple" ? command : null;
}

/**
 * The program `sh -c source` starts and then only stands for
 * (`runCommandString`): its name and arguments. Null when the shell does
 * anything more with the line: it is not one plain command (plainWords.ts),
 * or its first word is the shell's own to run. A shell that starts with
 * `-c` has no function or alias yet.
 */
export function loneProgram(source: string): string[] | null {
  const command = loneSimpleCommand(source);
  if (command === null || command.assignments.length > 0 || command.redirects.length > 0) {
    return null;
  }
  const argv: string[] = [];
  for (const word of command.words) {
    const text = literalText(word);
    if (text === null || !isPlainWord(text)) {
      return null;
    }
    argv.push(text);
  }
  return argv.length === 0 || BUILTINS[argv[0]] || COMMANDS[argv[0]] ? null : argv;
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

/** True when `command` runs the `jobs` builtin by itself (no function of that name). */
function listsJobs(command: AstCommand, functions: Map<string, FunctionDef>): boolean {
  const name = command.type === "simple" ? command.words[0] : undefined;
  return name !== undefined && literalText(name) === "jobs" && !functions.has("jobs");
}

function internalStage(stage: Prepared): boolean {
  return stage.kind === "internal";
}

/** One shell: the main one or a subshell (a copy that cannot change its parent). */
export class Shell {
  vars: Map<string, Variable>;
  functions: Map<string, FunctionDef>;
  aliases: Map<string, string>;
  positional: string[];
  arg0: string;
  cwd: string;
  /**
   * The file mode creation mask (`umask`): the process's own in the main
   * shell, and in a subshell a copy that is the subshell's to change.
   */
  umask: number;
  /** `fs`, once it was asked for. */
  private maskedFs: FsBackend | null = null;
  options: ShellOptions;
  traps: Map<string, string>;
  /** Names given to `export` while unset: exported once they are assigned. */
  pendingExports = new Set<string>();
  /** `$?`. */
  status = 0;
  /** `$!`. */
  lastBackground: number | undefined;
  /** The background jobs this shell started, which its `jobs`, `wait` and `%N` name. */
  jobList: JobList = newJobList();
  /** How the last simple command ended when it ran an external program; null for one of the shell's own. */
  lastExit: ExitStatus | null = null;
  /**
   * The next simple command this shell runs is its last act, which bash
   * does by exec'ing the program (the lone command of `sh -c`): a program it
   * starts stands for the shell (`ProcessState.standIn`).
   */
  private replaced = false;
  /** In a background job run in this process: how `kill` reaches it. */
  private job: JobControl | null = null;
  /** In a pipeline stage: the pipe it writes to; the stage ends once nobody reads it. */
  stageOutput: number | null = null;
  /** This shell runs a background job: the terminal's signals are not for its commands. */
  background = false;
  /**
   * This shell runs a background job of a shell with job control: its
   * programs start in process groups of their own, out of the terminal's
   * foreground. Without job control (a script, `sh -c`) a background
   * program stays in the shell's group, so the terminal's Ctrl+C reaches it.
   */
  private ownGroups = false;
  /** The shell's own fds; `exec 3>file` changes it. */
  fds: FdTable;
  /** True for the main shell, whose `cd` moves the process's working directory. */
  readonly root: boolean;
  /** The main shell of the process: itself, or the one this subshell descends from. */
  readonly main: Shell;
  readonly process: ProcessState;
  /** Saved variables of each active function call, for `local`. */
  readonly localScopes: Map<string, Variable | undefined>[] = [];
  /** Nesting of `if`/`while` conditions and `&&`/`||` heads, where `set -e` does not apply. */
  errexitSuppressed = 0;
  loopDepth = 0;
  /** In a subshell: how many loops of the shells it descends from it runs inside. */
  private outerLoops = 0;
  functionDepth = 0;
  sourceDepth = 0;
  /** Status of the last command substitution, for a command with no command word. */
  private lastSubstitutionStatus: number | null = null;
  /**
   * While the EXIT trap runs: the status the shell was ending with, which
   * an `exit` without an operand there keeps, whatever the trap's commands
   * returned.
   */
  exitTrapStatus: number | null = null;
  private currentLine = 0;

  constructor(options: {
    arg0: string;
    positional: string[];
    env: Record<string, string>;
    cwd: string;
    /** The file mode creation mask it starts with: the process's, for the main shell. */
    umask: number;
    process: ProcessState;
    /** For a subshell: the main shell it descends from. */
    main?: Shell;
  }) {
    this.arg0 = options.arg0;
    this.positional = options.positional;
    this.cwd = options.cwd;
    this.process = options.process;
    this.main = options.main ?? this;
    this.root = options.main === undefined;
    this.umask = options.umask;
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

  /**
   * A subshell: a deep copy whose changes stay inside it. It lists none of
   * the jobs of this shell, as bash's forked subshell does, unless
   * `inherit`: then it lists them, and cannot wait for them (`inheritJobs`).
   */
  subshell(inherit = false): Shell {
    const sub = new Shell({
      arg0: this.arg0,
      positional: [...this.positional],
      env: {},
      cwd: this.cwd,
      umask: this.umask,
      process: this.process,
      main: this.main,
    });
    for (const [name, variable] of this.vars) {
      sub.vars.set(name, { ...variable });
    }
    sub.background = this.background;
    sub.ownGroups = this.ownGroups;
    sub.stageOutput = this.stageOutput;
    sub.job = this.job;
    sub.functions = new Map(this.functions);
    sub.aliases = new Map(this.aliases);
    sub.traps = new Map();
    sub.pendingExports = new Set(this.pendingExports);
    sub.options = { ...this.options };
    sub.status = this.status;
    sub.lastBackground = this.lastBackground;
    if (inherit) {
      sub.jobList = inheritJobs(this.jobList);
    }
    sub.fds = new Map(this.fds);
    sub.errexitSuppressed = this.errexitSuppressed;
    sub.loopDepth = 0;
    sub.outerLoops = this.outerLoops + this.loopDepth;
    sub.functionDepth = 0;
    return sub;
  }

  get interactive(): boolean {
    return this.process.interactive;
  }

  /** Whether this shell's commands run in the foreground: not in a background job. */
  private get isForeground(): boolean {
    return this.job === null && !this.background;
  }

  /** Whether this shell has job control: an interactive shell, and not a subshell of one. */
  private get jobControl(): boolean {
    return this.interactive && this.root;
  }

  // ---- variables ----

  /** A variable or special parameter's value; undefined when unset. */
  get(name: string): string | undefined {
    switch (name) {
      case "?":
        return String(this.status);
      case "$":
        // The shell's, also in the jobs it handed to a new process.
        return String(this.process.handedOver?.pid ?? runtime().pid);
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
        return String(this.process.handedOver?.ppid ?? runtime().ppid);
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

  /**
   * The path the filesystem gets for one the shell opens itself: a
   * redirection's target, a file to source, the script it runs. As for a
   * command's operand (`absolutePath`), nothing in it is resolved here, so
   * `..` after a linked directory, the permissions of the directories on the
   * way and an empty path mean what they mean to a program.
   */
  resolve(path: string): string {
    return absolutePath(this.cwd, path);
  }

  /**
   * The filesystem this shell's redirections and commands create through:
   * what they make is masked by this shell's mask (umask.ts).
   */
  get fs(): FsBackend {
    this.maskedFs ??= filesystemUnder(() => this.umask);
    return this.maskedFs;
  }

  /** Sets the file mode creation mask (the process's too, in the main shell). */
  setUmask(mask: number): void {
    this.umask = mask;
    if (this.root) {
      runtime().umask = mask;
    }
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
      exists: (path) => tryStat(path, false) !== null,
      isDirectory: (path) => {
        const stat = tryStat(path);
        return stat !== null && isDir(stat);
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

  /**
   * Runs `sh -c` text. A lone simple command is the shell's last act, which
   * bash does by exec'ing the program: the shell then ends as it ended, of
   * its signal too, so the shell's parent sees what it would have.
   */
  async runCommandString(source: string): Promise<number> {
    this.lastExit = null;
    const lone = loneSimpleCommand(source) !== null;
    this.replaced = lone;
    let status: number;
    try {
      status = await this.runSource(source);
    } finally {
      this.replaced = false;
    }
    // Set by the command run meanwhile.
    const last = this.lastExit as ExitStatus | null;
    const signal = last?.signal ?? null;
    if (signal !== null && lone) {
      throw new ExitSignal(status, signal);
    }
    return status;
  }

  /** Runs a list. */
  async runList(list: List, fds: FdTable): Promise<number> {
    let status = this.status;
    for (const item of list.items) {
      if (item.background) {
        await this.startBackground(item.andOr, fds, item.source);
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
      throw new ExitSignal(signalExitStatus("SIGPIPE"));
    }
    if (this.job?.signal) {
      throw new ExitSignal(signalExitStatus(this.job.signal));
    }
    if (this.process.pendingSignal === null || this.leavesToMain(this.process.pendingSignal)) {
      if (!eventLoopStarved()) {
        return;
      }
      // Commands that never wait (`while :; do :; done`) would keep the worker
      // from ever handling the kernel's signal message: let queued tasks run.
      await yieldToEventLoop();
    }
    const signal = this.process.pendingSignal;
    // A background job ignores the terminal's signals, as in bash.
    if (signal === null || this.background || this.leavesToMain(signal)) {
      return;
    }
    const short = signal.replace(/^SIG/, "");
    const trap = this.traps.get(short);
    if (trap !== undefined) {
      settleSignal(this.process);
      if (trap !== "") {
        await this.runTrap(trap);
      }
      return;
    }
    this.endOfSignal(signal);
  }

  /**
   * Whether this subshell leaves pending `signal` to the main shell, which
   * has a trap for it: a signal sent to the shell is not one of its
   * subshells' in bash, which are processes of their own, so the subshell
   * runs on and the main shell runs the trap once the subshell has ended.
   */
  private leavesToMain(signal: string): boolean {
    return (
      !this.root && this.process.pendingForMain && this.main.traps.has(signal.replace(/^SIG/, ""))
    );
  }

  /**
   * Runs the commands of a signal's trap. They start with `$?` as the
   * command the signal came during left it, and it is that again once they
   * have run, as in bash: `wait`, interrupted, still says 128 + the signal.
   */
  private async runTrap(action: string): Promise<void> {
    const status = this.status;
    await this.runSource(action);
    this.status = status;
  }

  /**
   * Delivers `signal`, which this shell sends its own process (`kill -TERM
   * $$`; with `viaKernel`, its process group), here and now: see
   * `raiseSignal`. False when the kernel is to act on it instead.
   */
  raise(signal: string, viaKernel: boolean): boolean {
    return raiseSignal(this.main, signal, viaKernel);
  }

  /**
   * What untrapped `signal`, pending, does to this shell: it ends a shell
   * that is not interactive, which dies of it, and abandons the command line
   * of one that is. It stays pending, so that the other stages of a
   * pipeline, and the shells around this subshell, stop too.
   */
  private endOfSignal(signal: string): never {
    if (!this.interactive || this.process.fatalSignal === signal) {
      throw new ExitSignal(signalExitStatus(signal), signal);
    }
    throw new InterruptSignal();
  }

  /**
   * After a command substitution: a signal that stopped it ends the shell
   * (or abandons the command line) there, before the command the
   * substitution belongs to runs, as bash dies of a signal while it reads a
   * substitution. A trapped signal waits for that command to end.
   */
  private checkSignalAfterSubstitution(): void {
    const signal = this.process.pendingSignal;
    if (
      signal === null ||
      !this.isForeground ||
      this.traps.has(signal.replace(/^SIG/, "")) ||
      this.leavesToMain(signal)
    ) {
      return;
    }
    this.endOfSignal(signal);
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
      // A job of its own until every stage has ended (`takeTerminalBack`).
      const counted = this.isForeground;
      this.process.pipelines += counted ? 1 : 0;
      try {
        status = await this.runMultiPipeline(pipeline, fds);
      } finally {
        this.process.pipelines -= counted ? 1 : 0;
      }
    }
    if (pipeline.negated) {
      status = status === 0 ? 1 : 0;
    }
    this.status = status;
    this.takeTerminalBack();
    this.announceAfterJob();
    return status;
  }

  /**
   * In an interactive shell, once a foreground job that ran a program has
   * ended and nothing else runs: the notices of the background jobs that
   * ended meanwhile, on the shell's standard error, as bash gives them once
   * it has waited for a foreground job.
   */
  private announceAfterJob(): void {
    if (!this.process.programRan || !this.jobControl || !this.isForeground) {
      return;
    }
    if (this.process.flows !== 1 || this.process.pipelines > 0) {
      // Inside a job still running: a pipeline's stage, a substitution.
      return;
    }
    this.process.programRan = false;
    const stderr = this.fds.get(2);
    announceEndedJobs(this.jobList, (text) => {
      if (stderr !== null && stderr !== undefined) {
        writeFd(stderr, text);
      }
    });
  }

  /**
   * In an interactive shell, once the foreground job (a pipeline that ran a
   * program) has ended and nothing else runs: takes the terminal back for
   * the shell, as bash does between jobs, so what the job left running no
   * longer gets the terminal's Ctrl+C or input (`tty.reclaim`).
   */
  takeTerminalBack(): void {
    if (!this.process.jobRan || !this.interactive || !this.isForeground) {
      return;
    }
    if (this.process.flows !== 1 || this.process.pipelines > 0) {
      // Inside a job still running: a pipeline's stage, a substitution.
      return;
    }
    this.process.jobRan = false;
    try {
      runtime().tty.reclaim(0);
    } catch {
      // Not a terminal any more.
    }
  }

  private async runMultiPipeline(pipeline: Pipeline, fds: FdTable): Promise<number> {
    const { commands } = pipeline;
    const n = commands.length;
    // A non-interactive shell's SIGINT during the pipeline, which its stages
    // got too: as in bash 3.2, the shell goes on if the first command lived
    // through it (caught it, or had ended), whatever the others did.
    const interrupted = this.process.interrupts;
    const decides = !this.interactive && this.isForeground && this.process.flows === 1;
    let firstLived = false;
    const pipes: { readFd: number; writeFd: number }[] = [];
    for (let i = 0; i < n - 1; i++) {
      pipes.push(openPipe());
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
      const command = commands[i];
      // bash lists its jobs to a lone `jobs` builtin run as a stage
      // (`jobs -p | xargs kill`), and to no other stage.
      const sub = this.subshell(listsJobs(command, this.functions));
      if (i < n - 1) {
        sub.stageOutput = pipes[i].writeFd;
      }
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
          // From now, not from when its turn to be waited for comes: a
          // signal for the pipeline reaches every program of it.
          this.passSignalsTo(started.pid);
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
    // Each of those stages is a line of work of its own while this one waits for them.
    const inProcess = this.isForeground ? stages.filter(internalStage).length : 0;
    this.process.flows += inProcess > 0 ? inProcess - 1 : 0;
    for (let i = 0; i < n; i++) {
      const stage = stages[i];
      if (stage.kind !== "internal") {
        continue;
      }
      running.push(
        (async () => {
          try {
            statuses[i] = await stage.run();
            if (i === 0) {
              firstLived = this.process.interrupts === interrupted;
            }
            // Output queued for a full pipe that the reader then refused:
            // a process writing it would have died of SIGPIPE (128 + 13).
            if (i < n - 1 && isBrokenPipe(pipes[i].writeFd)) {
              statuses[i] = signalExitStatus("SIGPIPE");
            }
          } finally {
            if (inProcess > 0) {
              this.process.flows -= 1;
            }
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
    const outcomes = await Promise.allSettled(running);
    this.process.flows += inProcess > 0 ? 1 : 0;
    // Every program of the pipeline is waited for, as bash waits for the
    // whole job, even when a Ctrl+C stopped the stages the shell ran itself:
    // what a program does on the SIGINT (a handler's last words) comes before
    // the prompt.
    for (let i = 0; i < n; i++) {
      const pid = pids[i];
      if (pid !== null) {
        // Of a Ctrl+C the shell left to them, the first command's fate is
        // the pipeline's, as in bash 3.2.
        const exit = await this.waitForegroundExit(pid, i === 0);
        statuses[i] = exitStatusNumber(exit);
        if (i === 0) {
          firstLived = exit.signal !== "SIGINT";
        }
      }
    }
    if (
      decides &&
      firstLived &&
      this.process.interrupts > interrupted &&
      this.process.pendingSignal === "SIGINT" &&
      !this.traps.has("INT")
    ) {
      settleSignal(this.process);
    }
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        throw outcome.reason;
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
      // An fd `exec` made the shell's inside (`{ exec 1>&2; } 2>file`) stays open.
      const kept = new Set(this.fds.values());
      opened.filter((fd) => !kept.has(fd)).forEach(closeFd);
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
    // The command itself, not what its expansions or a function it names run.
    const standsIn = this.replaced;
    this.replaced = false;
    const prepared = await this.prepareSimple(command, fds);
    return this.runPrepared(prepared, standsIn);
  }

  /** Runs a prepared command; `standsIn`: a program it starts stands for the shell, as after `exec`. */
  private async runPrepared(prepared: Prepared, standsIn = false): Promise<number> {
    let status: number;
    switch (prepared.kind) {
      case "status":
        status = prepared.status;
        break;
      case "internal":
        this.lastExit = null;
        try {
          status = await prepared.run();
        } finally {
          prepared.opened.forEach(closeFd);
        }
        break;
      case "external": {
        const started = this.spawnExternal(prepared.argv, prepared.env, prepared.table);
        this.closeAfterExit(started, prepared.opened);
        if ("pid" in started) {
          this.lastExit = await this.waitForegroundExit(started.pid, true, standsIn);
          status = exitStatusNumber(this.lastExit);
        } else {
          this.lastExit = null;
          status = started.status;
        }
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
      // `exec 3>file`: the redirections apply to the shell itself. They are
      // made with the fds in effect here (in a pipeline's stage `4<&0` is the
      // pipe), and what they change is the shell's from now on; the other
      // fds of a redirected group or stage stay as they are until it ends.
      const { table } = await this.applyRedirects(command.redirects, fds);
      for (const [fd, real] of table) {
        if (!fds.has(fd) || fds.get(fd) !== real) {
          this.fds.set(fd, real);
          fds.set(fd, real);
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
          this.withTemporaryVars(prefix, () => {
            const io = this.commandIo(table);
            return this.runOwn(`sh: ${name}`, io, false, () => builtin(this, args, io));
          }),
      };
    }
    const command = COMMANDS[name];
    if (command) {
      return {
        kind: "internal",
        opened: [],
        run: async () => {
          const io = this.commandIo(table);
          const ctx = this.commandContext(name, io, this.environment(prefix));
          // A program of its own: a process elsewhere, which the signal
          // that stops this shell's commands ends.
          const counted = this.isForeground;
          const stop = this.stopSignal();
          const stoppedBefore = stop.aborted;
          this.process.flows += counted ? 1 : 0;
          try {
            const status = await this.runOwn(
              name,
              io,
              true,
              () => command(ctx, args),
              SHELL_BUILTIN_COMMANDS.has(name),
            );
            // Reached by that signal while it ran, the process would have
            // died of it, whatever the program it ran did: 128 + the
            // signal's number.
            return stop.aborted && !stoppedBefore ? this.stoppedStatus() : status;
          } finally {
            this.process.flows -= counted ? 1 : 0;
            if (counted && !SHELL_BUILTIN_COMMANDS.has(name)) {
              this.process.programRan = true;
            }
          }
        },
      };
    }
    return { kind: "external", argv, env: this.environment(prefix), table, opened: [] };
  }

  /**
   * The I/O of a command this shell runs itself. Its reads of a pipe or a
   * terminal end with the signal that stops this shell's commands; in a
   * background job of a shell with job control, a read of the terminal
   * waits for that signal, as a background process's read waits.
   */
  private commandIo(table: FdTable): CommandIo {
    return new CommandIo(table, {
      signal: this.stopSignal(),
      background: !this.isForeground && this.interactive,
    });
  }

  /**
   * Runs a builtin or a built-in program to its status, as a process would
   * end: one whose read a signal interrupted ends of that signal (128 + its
   * number), and one whose write to standard output failed says so on
   * standard error, `label` first, and fails. Its output is waited for. A
   * `program` that throws anything else fails with that message, as a
   * process of its own would; what a builtin throws is the shell's.
   * `inShell`: a shell runs the command itself, as a builtin (the builtins
   * here, and the programs here that are builtins of bash).
   */
  private async runOwn(
    label: string,
    io: CommandIo,
    program: boolean,
    run: () => number | Promise<number>,
    inShell = !program,
  ): Promise<number> {
    let status: number;
    try {
      status = await run();
    } catch (error) {
      if (error instanceof ReadInterrupted) {
        status = this.stoppedStatus();
      } else if (program && error instanceof Error) {
        io.err(`${label}: ${error.message}\n`);
        status = 1;
      } else {
        // The shell's own: `exit` and the like, also through a program that
        // runs commands (xargs).
        throw error;
      }
    } finally {
      // What it wrote is waited for until it is in its pipes, as a write(2)
      // on a full pipe would have waited before the command went on, but
      // without blocking the other stages of a pipeline. SIGINT or SIGTERM
      // (for a background job, its `kill`) stops the wait, the output staying
      // queued, so a Ctrl+C gets through a reader that never reads.
      const settled = io.settle();
      if (settled) {
        await this.untilStopped(settled);
      }
    }
    if (io.lostReader()) {
      return this.afterBrokenPipe(label, io, inShell, status);
    }
    const failed = io.takeWriteError();
    if (failed === null) {
      return status;
    }
    io.err(`${label}: write error: ${errnoText(failed.code)}\n`);
    return status === 0 ? 1 : status;
  }

  /**
   * What a write to a pipe nobody reads does to the command of this shell's
   * own that made it, as SIGPIPE would. A program with a process of its own
   * dies of it (141), and the shell goes on. A command the shell runs
   * itself (`inShell`) is the shell: the subshell that ran it ends with 141,
   * and the main shell dies of SIGPIPE. With PIPE ignored (`trap '' PIPE`),
   * or trapped by the shell that wrote, the write only fails: the command
   * says so and fails, and the trap runs after it.
   */
  private afterBrokenPipe(label: string, io: CommandIo, inShell: boolean, status: number): number {
    const trap = this.traps.get("PIPE");
    if (trap === "" || this.main.traps.get("PIPE") === "" || (inShell && trap !== undefined)) {
      io.err(`${label}: write error: ${errnoText("EPIPE")}\n`);
      return status === 0 ? 1 : status;
    }
    const died = signalExitStatus("SIGPIPE");
    if (!inShell) {
      return died;
    }
    throw new ExitSignal(died, this.root ? "SIGPIPE" : null);
  }

  /** The status of a command of this shell's own that the signal stopping them ended. */
  private stoppedStatus(): number {
    const signal = this.job?.signal ?? this.process.pendingSignal ?? "SIGINT";
    return signalExitStatus(signal);
  }

  /**
   * What stops this shell's commands early: for a background job only the
   * `kill` sent to it, as a Ctrl+C or a signal to the shell is for the
   * foreground; otherwise those. Each signal the shell acts on aborts the
   * one current then; a command that goes on after it asks again.
   */
  stopSignal(): AbortSignal {
    return this.job ? this.job.abort.signal : this.process.abort.signal;
  }

  /**
   * What wakes `wait`: what stops this shell's commands (`stopSignal`), and
   * in the foreground a trapped signal as well (`ProcessState.wake`).
   */
  wakeSignal(): AbortSignal {
    return this.job ? this.job.abort.signal : this.process.wake.signal;
  }

  /**
   * What `waiting` resolves to, or null once this shell's commands are
   * stopped first (or `signal` is aborted first, when it is given).
   */
  async untilStopped<T>(waiting: Promise<T>, signal = this.stopSignal()): Promise<T | null> {
    if (signal.aborted) {
      return null;
    }
    let onAbort = () => {};
    const aborted = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([waiting, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** The context a built-in command runs with. */
  commandContext(name: string, io: CommandIo, env: Record<string, string>): CommandContext {
    return {
      name,
      cwd: this.cwd,
      fs: this.fs,
      env,
      io,
      signal: this.stopSignal(),
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

  /**
   * Runs `argv` with the given fds and waits for it (for `command`, `xargs`,
   * `find -exec`). `standsIn`: for `exec`, whose program stands for the shell.
   */
  async execArgv(
    argv: string[],
    table: FdTable,
    skipFunctions = false,
    prefix: Record<string, string> = {},
    standsIn = false,
  ): Promise<number> {
    return this.runPrepared(this.prepareArgv(argv, prefix, table, skipFunctions), standsIn);
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
    try {
      for (const redirect of redirects) {
        await this.applyRedirect(redirect, table, opened);
      }
    } catch (error) {
      opened.forEach(closeFd);
      throw error;
    }
    return { table, opened };
  }

  private async applyRedirect(redirect: Redirect, table: FdTable, opened: number[]): Promise<void> {
    const ctx = this.expandContext(table);
    const { op } = redirect;
    if (op === "<<" || op === "<<-" || op === "<<<") {
      let text: string;
      if (op === "<<<") {
        text = `${await expandString(redirect.target, ctx)}\n`;
      } else {
        text = await expandString(redirect.heredoc?.body ?? { parts: [] }, ctx);
      }
      const pipe = openPipe();
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
        const named = this.namedDescriptor(target, table);
        const real = named ?? this.openFile(target, O_WRONLY | O_CREAT | O_TRUNC, true);
        if (named === null) {
          opened.push(real);
        }
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
    const named = this.namedDescriptor(target, table);
    const real = named ?? this.openFile(target, flags, op === ">");
    if (named === null) {
      opened.push(real);
      if (op === "<" || op === "<>") {
        trackFileOffset(real);
      }
    }
    for (const fd of fds) {
      table.set(fd, real);
    }
  }

  /**
   * The real fd behind a redirection target that names one of the command's
   * own fds (`/dev/stderr`, `/dev/fd/3`), among the fds in effect: the
   * redirection duplicates that fd, as bash does for these names where the
   * system has no such files. Opened by the kernel, the name would be the
   * shell process's fd, whatever the command's redirections and its place in
   * a pipeline. Null for any other target.
   */
  private namedDescriptor(target: string, table: FdTable): number | null {
    const named = descriptorOf(target);
    if (named === null) {
      return null;
    }
    const real = table.get(named);
    if (real === undefined || real === null) {
      throw new RedirectError(`${target}: No such file or directory`);
    }
    return real;
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
    const fs = this.fs;
    if (clobberCheck && this.options.noclobber && path !== "/dev/null" && fs.exists(path)) {
      throw new RedirectError(`${target}: cannot overwrite existing file`);
    }
    try {
      return path === "/dev/null" ? openNull(flags) : fs.open(path, flags, 0o666);
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
      if (real !== null && real !== undefined) {
        // What a `read` took past its line is the program's to read.
        giveBackInput(real);
      }
    }
    const name = argv[0];
    const notFound = () => {
      this.error(
        name.includes("/") ? `${name}: No such file or directory` : `command not found: ${name}`,
        table,
      );
      return { status: 127 };
    };
    try {
      // A forked child stays in the shell's directory: nothing changes into
      // it, so nothing checks it (inheritCwd).
      const request: SpawnRequest = {
        command: name,
        args: argv.slice(1),
        cwd: this.cwd,
        env,
        stdio,
        newGroup: this.ownGroups,
        inheritCwd: true,
        // As a forked child keeps its shell's mask: a subshell's own.
        umask: this.umask,
      };
      const child = rt.processes.spawn(request);
      this.trackExit(child.pid);
      if (this.isForeground) {
        this.process.programRan = true;
      }
      if (!this.ownGroups) {
        // It runs in the shell's group, the terminal's foreground.
        this.process.jobRan = true;
      }
      return { pid: child.pid };
    } catch (error) {
      const record = toSystemErrorRecord(error);
      if (record?.code === "ENOENT") {
        return notFound();
      }
      if (record && ["EACCES", "EISDIR", "ENOEXEC", "EPERM"].includes(record.code)) {
        // bash's words: a path to a directory "Is a directory"; a name is the
        // first regular file of that name on PATH, by its path there, and
        // not found when PATH has none (only directories, or ones it may
        // not search).
        if (name.includes("/")) {
          const stat = tryStat(this.resolve(name));
          const directory = record.code === "EISDIR" || (stat !== null && isDir(stat));
          this.error(`${name}: ${directory ? "Is a directory" : "Permission denied"}`, table);
          return { status: 126 };
        }
        const found = (env.PATH ?? DEFAULT_PATH)
          .split(":")
          .filter((directory) => directory !== "")
          .map((directory) => `${directory.replace(/\/+$/, "")}/${name}`)
          .find((candidate) => {
            const stat = tryStat(this.resolve(candidate));
            return stat !== null && isFile(stat);
          });
        if (found === undefined) {
          return notFound();
        }
        this.error(`${found}: Permission denied`, table);
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

  /** How child `pid` ends: its code or its signal. */
  private trackExit(pid: number): Promise<ExitStatus> {
    const existing = this.process.exits.get(pid);
    if (existing) {
      return existing;
    }
    const promise = new Promise<ExitStatus>((resolve) => {
      runtime().processes.onExit(pid, resolve);
    });
    this.process.exits.set(pid, promise);
    return promise;
  }

  /** Waits for a child in the foreground (signals are forwarded to it); its status. */
  async waitForeground(pid: number): Promise<number> {
    return exitStatusNumber(await this.waitForegroundExit(pid));
  }

  /**
   * Waits for a child in the foreground; how it ended. A SIGINT the shell
   * left to it meanwhile (`deferInterrupt`) is acted on once it has ended,
   * if it died of it and it `decides` for the shell. `standsIn`: the child
   * stands for the shell meanwhile (`ProcessState.standIn`). A signal that
   * ends the shell ends the wait (`unlessShellEnds`).
   */
  private async waitForegroundExit(
    pid: number,
    decides = true,
    standsIn = false,
  ): Promise<ExitStatus> {
    this.passSignalsTo(pid);
    const wait = { interrupted: false };
    if (this.isForeground) {
      this.process.waiting.add(wait);
    }
    // Of the main shell only: a subshell that execs is replaced, its shell is not.
    const stands = standsIn && this.root && this.process.standIn === null;
    if (stands) {
      // Every signal is the program's now: the shell hears of each, to pass
      // it on, where it would have died of some at once.
      this.process.standIn = pid;
      declareEverySignalHandled();
    }
    try {
      const exit = await this.unlessShellEnds(this.trackExit(pid));
      if (exit.signal === "SIGINT" && this.isForeground) {
        if (decides && wait.interrupted) {
          interruptShell(this.process, "SIGINT");
        } else if (this.interactive && !this.traps.has("INT")) {
          if (this.loopDepth + this.outerLoops > 0) {
            // As bash with job control: a foreground job that dies of SIGINT
            // inside a loop abandons the command line, or the loop would go
            // on to its next program for ever.
            interruptShell(this.process, "SIGINT");
          } else if (!this.root) {
            // A subshell is a process of the foreground job in bash: the
            // Ctrl+C that ended its program reached it too, and it dies of
            // it. The shell goes on after the subshell.
            throw new ExitSignal(signalExitStatus("SIGINT"));
          }
        }
      }
      return exit;
    } finally {
      if (stands) {
        this.process.standIn = null;
        declareHandledSignals(this.main.traps.keys());
      }
      this.process.waiting.delete(wait);
      this.job?.children.delete(pid);
      this.process.foreground.delete(pid);
      this.process.exits.delete(pid);
    }
  }

  /**
   * Program `pid` is one this shell runs and waits for: until it has ended,
   * a signal sent to the shell is passed on to it (`receiveSignal`), and so
   * is the `kill` of the background job this shell runs. A background job's
   * programs are not the terminal's: a signal meant for the foreground
   * leaves them, and their job, alone.
   */
  private passSignalsTo(pid: number): void {
    const { job, process } = this;
    const programs = job === null ? process.foreground : job.children;
    if (programs.has(pid)) {
      return;
    }
    programs.add(pid);
    void this.trackExit(pid).then(() => programs.delete(pid));
  }

  /**
   * What `waiting`, a wait for a foreground program, resolves to. Once a
   * signal ends the shell without a trap to run first, the wait is over
   * instead: the shell dies of the signal, as bash does, whatever its
   * programs do.
   */
  private async unlessShellEnds<T>(waiting: Promise<T>): Promise<T> {
    if (!this.isForeground) {
      return waiting;
    }
    const { process } = this;
    const ending = process.ending.signal;
    let onAbort = (): void => {};
    const ended = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      if (ending.aborted) {
        onAbort();
      } else {
        ending.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      const outcome = await Promise.race([waiting.then((value) => ({ value })), ended]);
      if (outcome !== null) {
        return outcome.value;
      }
    } finally {
      ending.removeEventListener("abort", onAbort);
    }
    throw fatalExit(process);
  }

  /**
   * Starts an and-or list in the background; resolves once it has been
   * started. `source` is the list as written, for `jobs`.
   */
  private async startBackground(andOr: AndOr, shellFds: FdTable, source?: string): Promise<void> {
    const subshell = () => {
      const sub = this.subshell();
      // A background job's commands do not take the terminal's Ctrl+C.
      sub.background = true;
      sub.ownGroups = this.ownGroups || this.jobControl;
      return sub;
    };
    // Without job control (a script, a subshell) a background command reads
    // /dev/null unless it redirects its input itself, as in bash: it never
    // takes input meant for the commands after it. With job control every
    // job keeps the shell's input, and its read of the terminal waits.
    const input = !this.jobControl && backgroundReadsNull(andOr) ? openNull(O_RDONLY) : null;
    const fds = input === null ? shellFds : new Map(shellFds).set(0, input);
    // A job run in this process gets a pid of its own for `$!`, `kill` and `wait`.
    const inProcess = (sub: Shell, run: () => Promise<number>, table: FdTable): void => {
      const control = new JobControl(sub.ownGroups);
      sub.job = control;
      job.pid = nextJobPid++;
      job.kill = (signal, wholeJob) => control.kill(signal, wholeJob);
      this.lastBackground = job.pid;
      job.done = sub
        .runAsSubshell(run, table)
        .catch((error: unknown) => (error instanceof ExitSignal ? error.status : 1))
        .then((status) => {
          // The signal `kill` sent ends it as it would a process, whatever
          // the command it stopped returned.
          if (control.signal === null) {
            return status;
          }
          job.signal = control.signal;
          return signalExitStatus(control.signal);
        });
    };
    // As bash: one more than the highest job still listed, so 1 again once all are gone.
    const id = Math.max(0, ...this.jobList.jobs.map((listed) => listed.id)) + 1;
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
      command: source ?? `job ${id}`,
      done: Promise.resolve(0),
      status: null,
      signal: null,
      ownGroup: false,
    };
    if (single) {
      const sub = subshell();
      const prepared = await sub.prepareSimpleSafely(single, fds);
      if (prepared.kind === "external") {
        const result = sub.spawnExternal(prepared.argv, prepared.env, prepared.table);
        this.closeAfterExit(result, prepared.opened);
        job.command = source ?? prepared.argv.join(" ");
        if ("pid" in result) {
          job.pid = result.pid;
          job.ownGroup = sub.ownGroups;
          this.lastBackground = result.pid;
          job.done = this.trackExit(result.pid).then((status) => {
            job.signal = status.signal;
            return exitStatusNumber(status);
          });
        } else {
          // It could not start. bash forks before it finds that out, so the
          // job has a pid all the same: `$!` names it, and `wait` says why
          // it failed.
          job.pid = nextJobPid++;
          this.lastBackground = job.pid;
          job.done = Promise.resolve(result.status);
        }
      } else {
        inProcess(sub, () => sub.runPrepared(prepared), fds);
      }
    } else {
      const sub = subshell();
      inProcess(sub, () => sub.runList({ items: [{ andOr, background: false }] }, fds), fds);
    }
    job.done = job.done.then((status) => {
      if (input !== null) {
        closeFd(input);
      }
      job.status = status;
      return status;
    });
    addJob(this.jobList, job);
    if (job.kill) {
      addOwnJob(this.process, job);
    }
    if (this.jobControl) {
      // `[1] 4194304`, on standard error as bash prints it; a subshell or a
      // pipeline stage of an interactive shell has no job control, and says nothing.
      const stderr = this.fds.get(2);
      if (stderr !== null && stderr !== undefined) {
        writeFd(stderr, `[${id}] ${job.pid ?? ""}`.trimEnd() + "\n");
      }
    }
  }

  // ---- command substitution ----

  /**
   * Runs a program in a subshell with the fds in effect where it is expanded
   * (`fds`), and returns what it wrote to standard output.
   */
  async substitute(program: Program, fds: FdTable = this.fds): Promise<string> {
    const pipe = openPipe();
    const table = new Map(fds);
    table.set(1, pipe.writeFd);
    // As in bash 3.2, it lists this shell's jobs (`$(jobs)`, `$(kill %1)`).
    const sub = this.subshell(true);
    let status = 0;
    // Read while it runs, as a shell does: its commands wait for their output
    // to be taken once the pipe is full.
    const reading = readAllAsync(pipe.readFd);
    // The reading is a line of work of its own: a Ctrl+C ends it.
    const counted = this.isForeground;
    this.process.flows += counted ? 1 : 0;
    try {
      status = await sub.runAsSubshell(() => sub.runList(program, table), table);
    } catch (error) {
      closeFd(pipe.writeFd);
      closeFd(pipe.readFd);
      await reading.catch(() => undefined);
      throw error;
    } finally {
      this.process.flows -= counted ? 1 : 0;
    }
    closeFd(pipe.writeFd);
    const bytes = await reading;
    closeFd(pipe.readFd);
    this.lastSubstitutionStatus = status;
    this.status = status;
    this.checkSignalAfterSubstitution();
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
    // An `exit` in the subshell's EXIT trap names the status it ends with.
    return (await this.runExitTrap(status, fds))?.status ?? status;
  }

  /**
   * Runs the EXIT trap, once, as this shell ends with `status`, with `fds`
   * (those of the subshell that ends). `$?` is `status` when its commands
   * start. Returns how an `exit` in the trap ends the shell instead (the
   * status it names; without an operand, `status`), or null when the trap's
   * commands ran to their end and the shell ends as it was ending.
   */
  async runExitTrap(status: number, fds: FdTable = this.fds): Promise<ExitSignal | null> {
    const trap = this.traps.get("EXIT");
    if (trap === undefined) {
      return null;
    }
    this.traps.delete("EXIT");
    this.status = status;
    this.exitTrapStatus = status;
    try {
      await this.runSource(trap, fds);
    } catch (error) {
      if (!(error instanceof ExitSignal)) {
        throw error;
      }
      return error;
    } finally {
      this.exitTrapStatus = null;
    }
    return null;
  }
}
